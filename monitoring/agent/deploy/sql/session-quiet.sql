-- Sent first in every session that handles the etg_monitor SCRAM verifier.
-- The verifier is secret, so no statement of this session may reach the
-- server log, whatever the server-level logging settings are: statement
-- logging, error-statement logging, duration logging and statement and
-- transaction sampling are all switched off for this session. The debug
-- parse-tree printers are switched off as well. Superuser-only settings:
-- the deploy connects as the database owner role.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET debug_print_parse = off;
SET debug_print_rewritten = off;
SET debug_print_plan = off;
