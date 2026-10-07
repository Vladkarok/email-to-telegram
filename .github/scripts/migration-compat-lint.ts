/**
 * Migration compatibility lint: a review aid, not a proof.
 *
 *   npx tsx .github/scripts/migration-compat-lint.ts drizzle/0013_example.sql ...
 *
 * CI runs it on the migrations a change adds. It flags statement shapes that
 * commonly break the release that is still running while a migration is
 * applied (and the image an automatic rollback goes back to). Each flagged
 * statement needs its own marker on the line directly before it:
 *
 *   -- compat: v1.11.0 no longer uses email_addresses.max_emails_hour
 *   -- compat: safe, <reason>
 *
 * The first form is for a contract change: the named release is the first
 * one that no longer uses the object, and the reviewer checks it against the
 * release production runs. The second is for everything else. See
 * CONTRIBUTING.md, "Database migrations".
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Shape =
  | "DROP TABLE"
  | "DROP COLUMN"
  | "RENAME"
  | "ALTER COLUMN ... TYPE"
  | "SET NOT NULL"
  | "ADD COLUMN ... NOT NULL without DEFAULT"
  | "ADD CONSTRAINT"
  | "CREATE UNIQUE INDEX"
  | "UPDATE"
  | "DELETE";

export interface Finding {
  /** 1-based line of the statement's first token. */
  line: number;
  shapes: Shape[];
  message: string;
}

interface Statement {
  line: number;
  /** Only whitespace precedes the statement on its first line. */
  ownLine: boolean;
  /** The statement with comments removed and literals replaced by placeholders. */
  code: string;
}

const CONTRACT_MARKER = /^\s*--\s*compat:\s*v\d+\.\d+\.\d+\s+no longer uses\s+\S/;
const SAFE_MARKER = /^\s*--\s*compat:\s*safe,\s*\S/;
const ANY_MARKER = /^\s*--\s*compat\b/i;
const MARKER_FORMS =
  '"-- compat: <release> no longer uses <object>" or "-- compat: safe, <reason>"';

const IDENT = String.raw`(?:"I"|[A-Z_][A-Z0-9_$]*)`;
const QUALIFIED = String.raw`${IDENT}(?:\.${IDENT})*`;
const ALTER_TYPE = new RegExp(String.raw`\bALTER (?:COLUMN )?${IDENT} (?:SET DATA )?TYPE\b`);
const UPDATE_DML = new RegExp(
  String.raw`\bUPDATE (?:ONLY )?(?!SET\b)${QUALIFIED}(?: (?:AS )?(?!SET\b)${IDENT})? SET\b`,
);
const ALTER_TABLE = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?\S+(?: \*)? (.*)$/;

/**
 * Splits SQL into statements at top-level semicolons. Comments are dropped,
 * string literals become '', quoted identifiers "I", and dollar-quoted bodies
 * $$ $$, so keywords inside them are never matched.
 */
function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let code = "";
  let start = -1;
  let i = 0;
  const lineStarts = [0];
  for (let k = 0; k < sql.length; k++) if (sql[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const begin = (): void => {
    if (start < 0) start = i;
  };
  const finish = (): void => {
    if (start >= 0) {
      const line = lineOf(start);
      const before = sql.slice(lineStarts[line - 1], start);
      statements.push({ line, ownLine: /^\s*$/.test(before), code: code.trim() });
    }
    code = "";
    start = -1;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      code += " ";
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      code += " ";
    } else if (ch === "'") {
      begin();
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      code += "''";
    } else if (ch === '"') {
      begin();
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') break;
        else i++;
      }
      i++;
      code += '"I"';
    } else if (ch === "$" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        begin();
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        code += "$$ $$";
      } else {
        begin();
        code += ch;
        i++;
      }
    } else if (ch === ";") {
      i++;
      finish();
    } else {
      if (!/\s/.test(ch)) begin();
      code += ch;
      i++;
    }
  }
  finish();
  return statements;
}

/** Splits an ALTER TABLE action list at top-level commas. */
function splitActions(actions: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of actions) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

export function shapesOf(code: string): Shape[] {
  const s = code.replace(/\s+/g, " ").trim().toUpperCase();
  const shapes = new Set<Shape>();
  if (/\bDROP TABLE\b/.test(s)) shapes.add("DROP TABLE");
  if (/\bDROP COLUMN\b/.test(s)) shapes.add("DROP COLUMN");
  if (/\bRENAME\b/.test(s)) shapes.add("RENAME");
  if (ALTER_TYPE.test(s)) shapes.add("ALTER COLUMN ... TYPE");
  if (/\bSET NOT NULL\b/.test(s)) shapes.add("SET NOT NULL");
  if (/\bADD CONSTRAINT\b/.test(s)) shapes.add("ADD CONSTRAINT");
  if (/\bCREATE UNIQUE INDEX\b/.test(s)) shapes.add("CREATE UNIQUE INDEX");
  if (UPDATE_DML.test(s)) shapes.add("UPDATE");
  if (/\bDELETE FROM\b/.test(s)) shapes.add("DELETE");

  const alter = ALTER_TABLE.exec(s);
  if (alter) {
    for (const action of splitActions(alter[1])) {
      if (/^DROP (?!CONSTRAINT\b)/.test(action)) {
        shapes.add("DROP COLUMN");
      } else if (
        /^ADD (?:CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/.test(action)
      ) {
        shapes.add("ADD CONSTRAINT");
      } else if (
        /^ADD\b/.test(action) &&
        /\bNOT NULL\b/.test(action) &&
        !/\b(?:DEFAULT|GENERATED)\b/.test(action)
      ) {
        shapes.add("ADD COLUMN ... NOT NULL without DEFAULT");
      }
    }
  }
  return [...shapes];
}

export function lintMigration(sql: string): Finding[] {
  const lines = sql.split("\n");
  const findings: Finding[] = [];
  for (const statement of splitStatements(sql)) {
    const shapes = shapesOf(statement.code);
    if (shapes.length === 0) continue;
    const what = shapes.join(", ");
    const previous = statement.line >= 2 ? lines[statement.line - 2] : "";
    let message: string | undefined;
    if (!statement.ownLine) {
      message = `${what}: start the statement on its own line, after a marker line (${MARKER_FORMS})`;
    } else if (CONTRACT_MARKER.test(previous) || SAFE_MARKER.test(previous)) {
      message = undefined;
    } else if (ANY_MARKER.test(previous)) {
      message = `${what}: malformed marker on the line before; use ${MARKER_FORMS}`;
    } else {
      message = `${what}: needs a marker on the line directly before it: ${MARKER_FORMS}`;
    }
    if (message) findings.push({ line: statement.line, shapes, message });
  }
  return findings;
}

export function main(
  files: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf-8"),
  write: (text: string) => void = (text) => process.stdout.write(text),
): number {
  if (files.length === 0) {
    write("migration compatibility lint: no added migrations\n");
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    const findings = lintMigration(read(file));
    for (const finding of findings) write(`${file}:${finding.line}: ${finding.message}\n`);
    if (findings.length > 0) failed++;
  }
  write(
    failed === 0
      ? `migration compatibility lint: ${files.length} file(s) ok\n`
      : `migration compatibility lint: ${failed} of ${files.length} file(s) need markers (CONTRIBUTING.md, "Database migrations")\n`,
  );
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
