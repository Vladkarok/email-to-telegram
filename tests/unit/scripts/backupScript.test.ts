import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs scripts/backup.sh under the system `sh` with pg_dump and
// dist/backupArchiveCli.js replaced by stubs, so no database or build is needed.

const SCRIPT_SOURCE = resolve(process.cwd(), "scripts/backup.sh");
const DATE_RE = String.raw`\d{4}-\d{2}-\d{2}`;

const PG_DUMP_STUB = `#!/bin/sh
if [ -n "\${STUB_PG_FAIL:-}" ]; then
  echo "partial dump"
  exit 1
fi
echo "SELECT 1;"
`;

const ARCHIVE_CLI_STUB = `const fs = require("node:fs");
const [command, input, output, aad] = process.argv.slice(2);
if (command !== "encrypt") process.exit(2);
if (process.env.STUB_ENCRYPT_FAIL) {
  fs.writeFileSync(output, "partial");
  process.stdout.write("backup_archive_encryption_mode=local-v1\\n");
  process.exit(1);
}
const finish = () => {
  fs.copyFileSync(input, output);
  process.stdout.write("backup_archive_encryption_mode=local-v1\\nbackup_archive_aad=" + aad + "\\n");
};
if (process.env.STUB_ENCRYPT_READY) {
  fs.writeFileSync(process.env.STUB_ENCRYPT_READY, "");
  setTimeout(finish, 1000);
} else {
  finish();
}
`;

let root: string;
let script: string;
let outDir: string;

function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: [join(root, "bin"), dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    DATABASE_URL: "postgres://user:secret@localhost:5432/db",
    STORAGE_ENCRYPTION_MODE: "local-v1",
    MASTER_ENCRYPTION_KEY: "test-key",
    ...extra,
  };
}

function runBackup(extra: Record<string, string>) {
  return spawnSync("sh", [script, outDir], {
    env: scriptEnv(extra),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

function listOut(): string[] {
  return readdirSync(outDir).sort();
}

function setAgeDays(path: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(path, when, when);
}

describe.skipIf(process.platform === "win32")("scripts/backup.sh", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "email-to-telegram-backup-sh-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "bin"));
    script = join(root, "scripts", "backup.sh");
    copyFileSync(SCRIPT_SOURCE, script);
    writeFileSync(join(root, "package.json"), '{ "type": "commonjs" }\n');
    writeFileSync(join(root, "dist", "backupArchiveCli.js"), ARCHIVE_CLI_STUB);
    writeFileSync(join(root, "bin", "pg_dump"), PG_DUMP_STUB);
    chmodSync(join(root, "bin", "pg_dump"), 0o755);
    outDir = join(root, "backups");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves only the encrypted dump and its metadata after a storage-key run", () => {
    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const files = listOut();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(new RegExp(`^backup-${DATE_RE}\\.meta$`));
    expect(files[1]).toMatch(new RegExp(`^backup-${DATE_RE}\\.sql\\.gz\\.etg$`));

    const meta = readFileSync(join(outDir, files[0]), "utf-8");
    expect(meta).toContain(`backup_file=${files[1]}`);
    expect(meta).toContain("backup_archive_encryption=storage-key");
    expect(meta).toContain("backup_archive_encryption_mode=local-v1");
    expect(meta).toContain(`backup_archive_aad=backup-archive:${files[1]}`);
  });

  it("leaves only the plain dump and its metadata when archive encryption is off", () => {
    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "off" });

    expect(result.status).toBe(0);
    const files = listOut();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(new RegExp(`^backup-${DATE_RE}\\.meta$`));
    expect(files[1]).toMatch(new RegExp(`^backup-${DATE_RE}\\.sql\\.gz$`));
    expect(readFileSync(join(outDir, files[0]), "utf-8")).not.toContain("backup_archive_aad=");
  });

  it("removes every temp file when encryption fails", () => {
    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key", STUB_ENCRYPT_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(listOut()).toEqual([]);
  });

  it("removes every temp file when pg_dump fails", () => {
    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key", STUB_PG_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(listOut()).toEqual([]);
  });

  it("stops on SIGTERM without committing metadata or leaving temp files", async () => {
    const ready = join(root, "encrypt-ready");
    const child = spawn("sh", [script, outDir], {
      env: scriptEnv({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key", STUB_ENCRYPT_READY: ready }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => resolveExit(code));
    });

    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("encrypt stub never started");
      await new Promise((r) => setTimeout(r, 20));
    }
    child.kill("SIGTERM");

    expect(await exited).toBe(143);
    expect(listOut()).toEqual([]);
  });

  it("sweeps temp files left by killed runs once they are past retention", () => {
    mkdirSync(outDir);
    const stale = [
      ".backup-2026-01-01-41.archive-meta",
      ".backup-2026-01-01-41.sql",
      ".backup-conn-2026-01-01-41.txt",
      "backup-2026-01-01.sql.gz.tmp",
      "backup-2026-01-01.sql.gz.etg.tmp",
      "backup-2026-01-01.meta.tmp",
    ];
    for (const name of stale) {
      writeFileSync(join(outDir, name), "leftover");
      setAgeDays(join(outDir, name), 10);
    }
    const fresh = [".backup-2026-01-02-42.sql", "backup-2026-01-02.sql.gz.tmp"];
    for (const name of fresh) {
      writeFileSync(join(outDir, name), "in progress");
      setAgeDays(join(outDir, name), 3);
    }

    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key" });

    expect(result.status).toBe(0);
    const files = listOut();
    for (const name of stale) expect(files).not.toContain(name);
    for (const name of fresh) expect(files).toContain(name);
    expect(files).toHaveLength(fresh.length + 2);
  });
});
