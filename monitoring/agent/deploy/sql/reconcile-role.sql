-- Reconciles etg_monitor, the read-only role postgres_exporter logs in as.
-- Runs after the quiet-session preamble (ETG_PG_QUIET_SQL in lib.sh), with
-- the psql variable :verifier set to the SCRAM-SHA-256 verifier computed on
-- the runner. One transaction: any error (ON_ERROR_STOP) leaves the role as
-- it was.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etg_monitor') THEN
    CREATE ROLE etg_monitor NOLOGIN;
  END IF;
END
$$;

-- Everything etg_monitor must not have, as a list of findings. A temporary
-- function (gone with the session) so the same checks run before and after
-- the repairs below: a repaired membership can bring privileges with it.
-- Nothing is revoked here; an unexpected privilege needs a person to look at
-- it. Grants and effective privileges are checked in the app database,
-- extension relations included: the app's only extension (pgcrypto) has
-- none, and a monitoring extension such as pg_stat_statements is not
-- installed, so there is nothing to exempt.
CREATE FUNCTION pg_temp.etg_monitor_problems() RETURNS text[]
LANGUAGE plpgsql AS $$
DECLARE
  r pg_roles%ROWTYPE;
  problems text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'etg_monitor';

  IF r.rolsuper THEN problems := problems || 'SUPERUSER'::text; END IF;
  IF r.rolcreatedb THEN problems := problems || 'CREATEDB'::text; END IF;
  IF r.rolcreaterole THEN problems := problems || 'CREATEROLE'::text; END IF;
  IF r.rolreplication THEN problems := problems || 'REPLICATION'::text; END IF;
  IF r.rolbypassrls THEN problems := problems || 'BYPASSRLS'::text; END IF;

  problems := problems || ARRAY(
    SELECT 'member of ' || g.rolname
           || CASE WHEN m.admin_option THEN ' WITH ADMIN OPTION' ELSE '' END
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
    WHERE m.member = r.oid AND (g.rolname <> 'pg_monitor' OR m.admin_option));

  problems := problems || ARRAY(
    SELECT 'owns ' || c.oid::regclass::text FROM pg_class c WHERE c.relowner = r.oid);
  problems := problems || ARRAY(
    SELECT 'owns schema ' || n.nspname FROM pg_namespace n WHERE n.nspowner = r.oid);
  problems := problems || ARRAY(
    SELECT 'owns function ' || p.oid::regprocedure::text FROM pg_proc p WHERE p.proowner = r.oid);
  problems := problems || ARRAY(
    SELECT 'owns database ' || d.datname FROM pg_database d WHERE d.datdba = r.oid);

  -- Explicit grants to the role itself.
  problems := problems || ARRAY(
    SELECT DISTINCT 'grant on ' || c.oid::regclass::text
    FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid);
  problems := problems || ARRAY(
    SELECT DISTINCT 'column grant on ' || c.oid::regclass::text || '.' || att.attname
    FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
    WHERE a.grantee = r.oid);
  problems := problems || ARRAY(
    SELECT DISTINCT 'grant on schema ' || n.nspname
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = r.oid);
  problems := problems || ARRAY(
    SELECT DISTINCT 'grant on database ' || d.datname
    FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = r.oid);
  problems := problems || ARRAY(
    SELECT DISTINCT 'grant on function ' || p.oid::regprocedure::text
    FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = r.oid);
  problems := problems || ARRAY(
    SELECT DISTINCT 'default privileges for ' || d.defaclobjtype::text
    FROM pg_default_acl d LEFT JOIN LATERAL aclexplode(d.defaclacl) a ON true
    WHERE d.defaclrole = r.oid OR a.grantee = r.oid);

  -- Effective privileges, whatever their source: the role's own grants,
  -- PUBLIC, and roles it inherits from (pg_monitor included).
  problems := problems || ARRAY(
    SELECT format('%s on %s', p.priv, c.oid::regclass)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND has_table_privilege(r.oid, c.oid, p.priv));
  problems := problems || ARRAY(
    SELECT format('column %s on %s', p.priv, c.oid::regclass)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND NOT has_table_privilege(r.oid, c.oid, p.priv)
      AND has_any_column_privilege(r.oid, c.oid, p.priv));
  problems := problems || ARRAY(
    SELECT format('%s on sequence %s', p.priv, c.oid::regclass)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(priv)
    WHERE c.relkind = 'S'
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND has_sequence_privilege(r.oid, c.oid, p.priv));

  RETURN problems;
END
$$;

DO $$
DECLARE
  problems text[] := pg_temp.etg_monitor_problems();
BEGIN
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'etg_monitor has unexpected privileges: %', array_to_string(problems, '; ');
  END IF;
END
$$;

-- Expected attributes: repaired when missing.
ALTER ROLE etg_monitor LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles u ON u.oid = m.member
    WHERE g.rolname = 'pg_monitor' AND u.rolname = 'etg_monitor' AND m.inherit_option
  ) THEN
    GRANT pg_monitor TO etg_monitor WITH INHERIT TRUE;
  END IF;
END
$$;

-- The repairs may have switched on inherited privileges: check again.
DO $$
DECLARE
  problems text[] := pg_temp.etg_monitor_problems();
BEGIN
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'etg_monitor has unexpected privileges after the repairs: %', array_to_string(problems, '; ');
  END IF;
END
$$;

ALTER ROLE etg_monitor PASSWORD :'verifier';

COMMIT;
