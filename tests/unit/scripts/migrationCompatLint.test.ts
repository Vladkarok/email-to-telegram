import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lintMigration, main, type Shape } from "../../../.github/scripts/migration-compat-lint.js";

const CONTRACT = "-- compat: v1.11.0 no longer uses t.c";
const SAFE = "-- compat: safe, the table is new in this release";

const FLAGGED: [Shape, string][] = [
  ["DROP TABLE", 'DROP TABLE "old_things";'],
  ["DROP COLUMN", 'ALTER TABLE "t" DROP COLUMN "c";'],
  ["DROP COLUMN", "ALTER TABLE t DROP c;"],
  ["RENAME", 'ALTER TABLE "t" RENAME COLUMN "a" TO "b";'],
  ["RENAME", 'ALTER TABLE "t" RENAME TO "u";'],
  ["ALTER COLUMN ... TYPE", 'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE bigint;'],
  ["ALTER COLUMN ... TYPE", "ALTER TABLE t ALTER c TYPE text USING c::text;"],
  ["SET NOT NULL", 'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;'],
  ["ADD COLUMN ... NOT NULL without DEFAULT", 'ALTER TABLE "t" ADD COLUMN "c" integer NOT NULL;'],
  ["ADD COLUMN ... NOT NULL without DEFAULT", "ALTER TABLE t ADD c integer NOT NULL;"],
  ["ADD CONSTRAINT", 'ALTER TABLE "t" ADD CONSTRAINT "t_c_unique" UNIQUE("c");'],
  ["ADD CONSTRAINT", "ALTER TABLE t ADD UNIQUE (c);"],
  ["ADD CONSTRAINT", "ALTER TABLE t ADD FOREIGN KEY (c) REFERENCES u (id);"],
  ["CREATE UNIQUE INDEX", 'CREATE UNIQUE INDEX "idx_t_c" ON "t" USING btree ("c");'],
  ["UPDATE", 'UPDATE "t" SET "c" = 0 WHERE "c" IS NULL;'],
  ["UPDATE", "WITH x AS (SELECT id FROM t) UPDATE t AS a SET c = 1 FROM x WHERE a.id = x.id;"],
  ["DELETE", 'DELETE FROM "t" WHERE "c" IS NULL;'],
];

const NOT_FLAGGED = [
  'CREATE TABLE "t" ("id" uuid PRIMARY KEY NOT NULL, "u" uuid REFERENCES "u"("id") ON DELETE cascade ON UPDATE no action, CONSTRAINT "chk" CHECK ("id" IS NOT NULL));',
  'CREATE INDEX "idx_t_c" ON "t" USING btree ("c");',
  'ALTER TABLE "t" ADD COLUMN "c" integer;',
  'ALTER TABLE "t" ADD COLUMN "c" integer DEFAULT 0 NOT NULL;',
  'ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" text;',
  'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;',
  'ALTER TABLE "t" DROP CONSTRAINT "chk";',
  'DROP INDEX "idx_t_c";',
  "INSERT INTO t (c) SELECT c FROM u ON CONFLICT DO NOTHING;",
  "SELECT 'DROP TABLE t; UPDATE t SET c = 1' AS text;",
  "COMMENT ON COLUMN t.c IS E'it\\'s fine to DELETE FROM here';",
  'SELECT 1 AS "DROP COLUMN";',
  "-- DROP TABLE t;\nSELECT 1;",
  "/* UPDATE t SET c = 1; /* nested */ still a comment */ SELECT 1;",
  "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN DELETE FROM t; END $body$ LANGUAGE plpgsql;",
];

describe("migration compatibility lint", () => {
  it.each(FLAGGED)("flags %s without a marker: %s", (shape, statement) => {
    const findings = lintMigration(`${statement}\n`);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
    expect(findings[0].shapes).toContain(shape);
  });

  it.each(FLAGGED)("passes %s with a contract marker: %s", (_shape, statement) => {
    expect(lintMigration(`${CONTRACT}\n${statement}\n`)).toEqual([]);
  });

  it.each(FLAGGED)("passes %s with a safe marker: %s", (_shape, statement) => {
    expect(lintMigration(`${SAFE}\n${statement}\n`)).toEqual([]);
  });

  it.each(NOT_FLAGGED)("does not flag %s", (statement) => {
    expect(lintMigration(`${statement}\n`)).toEqual([]);
  });

  it("fails a file with one marked and one unmarked statement", () => {
    const sql = [
      SAFE,
      'CREATE UNIQUE INDEX "idx_a" ON "t" ("a");',
      "--> statement-breakpoint",
      'ALTER TABLE "t" DROP COLUMN "b";',
      "",
    ].join("\n");

    const findings = lintMigration(sql);

    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
    expect(findings[0].shapes).toEqual(["DROP COLUMN"]);
  });

  it("needs one marker per statement", () => {
    const sql = `${SAFE}\nUPDATE t SET c = 1;\nDELETE FROM t WHERE c = 2;\n`;

    const findings = lintMigration(sql);

    expect(findings.map((finding) => finding.line)).toEqual([3]);
  });

  it("works with drizzle's breakpoints at the end of the previous line", () => {
    const sql = `CREATE TABLE "t" ("id" uuid);--> statement-breakpoint\n${CONTRACT}\nALTER TABLE "u" DROP COLUMN "c";--> statement-breakpoint\nCREATE INDEX "i" ON "t" ("id");\n`;

    expect(lintMigration(sql)).toEqual([]);
  });

  it("accepts CRLF line ends", () => {
    expect(lintMigration(`${SAFE}\r\nDROP TABLE t;\r\n`)).toEqual([]);
  });

  it("needs the marker directly before the statement", () => {
    const findings = lintMigration(`${SAFE}\n\nDROP TABLE t;\n`);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("needs a marker on the line directly before it");
  });

  it("does not accept another comment between marker and statement", () => {
    expect(lintMigration(`${SAFE}\n-- explanation\nDROP TABLE t;\n`)).toHaveLength(1);
  });

  it.each([
    "-- compat: v1.11 no longer uses t.c",
    "-- compat: v1.11.0 drops t.c",
    "-- compat: safe",
    "-- compat: safe,",
    "-- COMPAT safe, reason",
  ])("reports a malformed marker: %s", (marker) => {
    const findings = lintMigration(`${marker}\nDROP TABLE t;\n`);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("malformed marker");
  });

  it("needs a flagged statement to start its own line", () => {
    const findings = lintMigration(`${SAFE}\nSELECT 1; DROP TABLE t;\n`);

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("start the statement on its own line");
  });

  it("reports the first line of a statement that spans several", () => {
    const findings = lintMigration("SELECT 1;\n\n-- note\nUPDATE t\nSET c = 1;\n");

    expect(findings.map((finding) => finding.line)).toEqual([4]);
  });

  it("passes the marked max_emails_hour migration", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "drizzle/0012_drop-max-emails-hour.sql"),
      "utf-8",
    );

    expect(sql).toContain("-- compat: v1.11.0 no longer uses email_addresses.max_emails_hour");
    expect(lintMigration(sql)).toEqual([]);
  });

  it("flags an older unmarked migration", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "drizzle/0006_alias-tombstone-uniqueness.sql"),
      "utf-8",
    );

    const shapes = lintMigration(sql).flatMap((finding) => finding.shapes);

    expect(shapes).toEqual(["UPDATE", "CREATE UNIQUE INDEX"]);
  });

  describe("main", () => {
    it("passes when no migration was added", () => {
      const out: string[] = [];

      expect(
        main(
          [],
          () => "",
          (text) => out.push(text),
        ),
      ).toBe(0);
      expect(out.join("")).toContain("no added migrations");
    });

    it("prints file and line of each finding and fails", () => {
      const files: Record<string, string> = {
        "drizzle/0013_a.sql": `${SAFE}\nDROP TABLE a;\n`,
        "drizzle/0014_b.sql": "SELECT 1;\nDROP TABLE b;\n",
      };
      const out: string[] = [];

      const status = main(
        Object.keys(files),
        (file) => files[file],
        (text) => out.push(text),
      );

      expect(status).toBe(1);
      expect(out.join("")).toContain("drizzle/0014_b.sql:2: DROP TABLE: needs a marker");
      expect(out.join("")).not.toContain("drizzle/0013_a.sql:");
      expect(out.join("")).toContain("1 of 2 file(s) need markers");
    });
  });
});
