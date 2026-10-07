import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Runs scripts/backup.sh with pg_dump and dist/backupArchiveCli.js replaced by
// stubs, so no database or build is needed. The app image runs the script under
// BusyBox ash with BusyBox utilities, so the suite does too whenever a busybox
// binary is available ($BUSYBOX, or `busybox` on PATH): PATH then holds only the
// stubs, node and BusyBox applets. Without one it falls back to the host `sh`
// and utilities, so the regression cases still run everywhere.

const SCRIPT_SOURCE = resolve(process.cwd(), "scripts/backup.sh");
const DATE_RE = String.raw`\d{4}-\d{2}-\d{2}`;
const READY_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 5_000;
// Covers the readiness wait, the backup runs and the cleanup in `finally`.
const BLOCKING_TEST_TIMEOUT_MS = READY_TIMEOUT_MS + SETTLE_TIMEOUT_MS + 15_000;

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

const BUSYBOX = process.env.BUSYBOX || findOnPath("busybox");
const SHELL_NAME = BUSYBOX ? "BusyBox ash" : "host sh";
const SHELL_ARGV = BUSYBOX ? [BUSYBOX, "ash"] : ["sh"];
// The programs backup.sh runs besides node and pg_dump; the rest are builtins.
const SCRIPT_UTILITIES = [
  "basename",
  "cat",
  "cut",
  "date",
  "dirname",
  "du",
  "find",
  "gzip",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
];

const PG_DUMP_STUB = `#!/bin/sh
if [ -n "\${STUB_PG_FAIL:-}" ]; then
  echo "partial dump"
  exit 1
fi
echo "SELECT 1;"
`;

// With STUB_ENCRYPT_READY and STUB_ENCRYPT_RELEASE set, the stub writes its
// output, creates the ready file and then holds the run inside encryption until
// the test creates the release file. It gives up if the fixture directory goes
// away, so it can never outlive a test.
const ARCHIVE_CLI_STUB = `const fs = require("node:fs");
const path = require("node:path");
const [command, input, output, aad] = process.argv.slice(2);
if (command !== "encrypt") process.exit(2);
if (process.env.STUB_ENCRYPT_FAIL) {
  fs.writeFileSync(output, "partial");
  process.stdout.write("backup_archive_encryption_mode=local-v1\\n");
  process.exit(1);
}
fs.copyFileSync(input, output);
const finish = () => {
  process.stdout.write("backup_archive_encryption_mode=local-v1\\nbackup_archive_aad=" + aad + "\\n");
};
const { STUB_ENCRYPT_READY: ready, STUB_ENCRYPT_RELEASE: release } = process.env;
if (ready && release) {
  fs.writeFileSync(ready, "");
  const timer = setInterval(() => {
    if (fs.existsSync(release)) {
      clearInterval(timer);
      finish();
    } else if (!fs.existsSync(path.dirname(release))) {
      process.exit(3);
    }
  }, 10);
} else {
  finish();
}
`;

let appletDir: string | undefined;
let root: string;
let script: string;
let outDir: string;

function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const path = appletDir
    ? [join(root, "bin"), appletDir]
    : [join(root, "bin"), dirname(process.execPath), process.env.PATH ?? ""];
  return {
    PATH: path.join(delimiter),
    DATABASE_URL: "postgres://user:secret@localhost:5432/db",
    STORAGE_ENCRYPTION_MODE: "local-v1",
    MASTER_ENCRYPTION_KEY: "test-key",
    ...extra,
  };
}

function runBackup(extra: Record<string, string>) {
  return spawnSync(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), script, outDir], {
    env: scriptEnv(extra),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
}

interface RunExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface BlockedRun {
  child: ChildProcess;
  ready: string;
  release: string;
  exit: Promise<RunExit>;
  done: () => boolean;
}

// Starts a storage-key backup whose encryption step blocks until release().
// The run gets its own process group so settle() can kill the shell and the
// stub together.
function startBlockedBackup(name: string, extra: Record<string, string> = {}): BlockedRun {
  const ready = join(root, `${name}.ready`);
  const release = join(root, `${name}.release`);
  const child = spawn(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), script, outDir], {
    env: scriptEnv({
      BACKUP_ARCHIVE_ENCRYPTION: "storage-key",
      STUB_ENCRYPT_READY: ready,
      STUB_ENCRYPT_RELEASE: release,
      ...extra,
    }),
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf-8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let finished = false;
  const exit = new Promise<RunExit>((resolveExit) => {
    child.on("error", (err) => {
      finished = true;
      resolveExit({ code: null, signal: null, stderr: String(err) });
    });
    // "close" waits for every holder of the stderr pipe, the stub included.
    child.on("close", (code, signal) => {
      finished = true;
      resolveExit({ code, signal, stderr });
    });
  });
  return { child, ready, release, exit, done: () => finished };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForEncryption(run: BlockedRun): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!existsSync(run.ready)) {
    if (run.done()) {
      const { code, signal, stderr } = await run.exit;
      throw new Error(`backup exited (${code ?? signal}) before encryption: ${stderr}`);
    }
    if (Date.now() > deadline) throw new Error("encrypt stub never started");
    await sleep(20);
  }
}

function release(run: BlockedRun): void {
  writeFileSync(run.release, "");
}

// For `finally`: lets the run finish, or kills its process group if it does
// not, and waits for it either way, so nothing outlives the fixture directory.
async function settle(run: BlockedRun): Promise<void> {
  if (run.done()) return;
  release(run);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), SETTLE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([run.exit, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout" && run.child.pid !== undefined) {
    try {
      process.kill(-run.child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    await run.exit;
  }
}

function listOut(): string[] {
  return readdirSync(outDir).sort();
}

function setAgeDays(path: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(path, when, when);
}

describe.skipIf(process.platform === "win32")(`scripts/backup.sh under ${SHELL_NAME}`, () => {
  beforeAll(() => {
    if (!BUSYBOX) return;
    appletDir = mkdtempSync(join(tmpdir(), "email-to-telegram-busybox-"));
    symlinkSync(process.execPath, join(appletDir, "node"));
    const list = spawnSync(BUSYBOX, ["--list"], { encoding: "utf-8" });
    if (list.status !== 0) throw new Error(`${BUSYBOX} --list failed: ${list.stderr}`);
    const applets = list.stdout.split("\n").filter((applet) => applet && applet !== "node");
    const missing = SCRIPT_UTILITIES.filter((utility) => !applets.includes(utility));
    if (missing.length > 0) throw new Error(`${BUSYBOX} lacks ${missing.join(", ")}`);
    for (const applet of applets) symlinkSync(BUSYBOX, join(appletDir, applet));
  });

  afterAll(() => {
    if (appletDir) rmSync(appletDir, { recursive: true, force: true });
  });

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

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const files = listOut();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(new RegExp(`^backup-${DATE_RE}\\.meta$`));
    expect(files[1]).toMatch(new RegExp(`^backup-${DATE_RE}\\.sql\\.gz$`));
    expect(readFileSync(join(outDir, files[0]), "utf-8")).not.toContain("backup_archive_aad=");
  });

  it("removes every temp file when the configuration is rejected", () => {
    const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "bogus" });

    expect(result.status).toBe(1);
    expect(listOut()).toEqual([]);
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

  it.each([
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "stops on %s without committing metadata or leaving temp files",
    async (signal, exitCode) => {
      const run = startBlockedBackup("signalled");
      try {
        await waitForEncryption(run);
        // Connection file, SQL dump, gzip, encrypted output and archive metadata,
        // all carrying this run's PID and mktemp token.
        const inFlight = listOut();
        expect(inFlight).toHaveLength(5);
        const conn = inFlight.find((name) => name.startsWith(".backup-conn-")) ?? "";
        const runId = new RegExp(`-(${run.child.pid}-[A-Za-z0-9]{6})$`).exec(conn)?.[1];
        expect(runId, `connection file ${conn}`).toBeDefined();
        for (const name of inFlight) expect(name).toContain(runId);

        // The shell runs the trap once the blocked encrypt step returns, so the
        // signal is already pending when the stub is released.
        expect(run.child.kill(signal)).toBe(true);
        release(run);

        const result = await run.exit;
        expect(result.signal).toBeNull();
        expect(result.code).toBe(exitCode);
        expect(listOut()).toEqual([]);
      } finally {
        await settle(run);
      }
    },
    BLOCKING_TEST_TIMEOUT_MS,
  );

  it(
    "never removes the temp files of a concurrent run",
    async () => {
      const slow = startBlockedBackup("slow");
      try {
        await waitForEncryption(slow);
        const slowTemps = listOut();

        // A same-day run that finishes while the first is still encrypting.
        const fast = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "off" });
        expect(fast.stderr).toBe("");
        expect(fast.status).toBe(0);
        expect(listOut()).toEqual(expect.arrayContaining(slowTemps));

        release(slow);
        const result = await slow.exit;
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        const files = listOut();
        expect(files).toHaveLength(3);
        expect(files[0]).toMatch(new RegExp(`^backup-${DATE_RE}\\.meta$`));
        expect(files[1]).toMatch(new RegExp(`^backup-${DATE_RE}\\.sql\\.gz$`));
        expect(files[2]).toBe(`${files[1]}.etg`);
        expect(readFileSync(join(outDir, files[0]), "utf-8")).toContain(`backup_file=${files[2]}`);
      } finally {
        await settle(slow);
      }
    },
    BLOCKING_TEST_TIMEOUT_MS,
  );

  describe("temp files left by killed runs", () => {
    const stale = [
      ".backup-conn-2026-01-01-41-AbCdEf",
      ".backup-2026-01-01-41-AbCdEf.sql",
      ".backup-2026-01-01-41-AbCdEf.archive-meta",
      "backup-2026-01-01.sql.gz.41-AbCdEf.tmp",
      "backup-2026-01-01.sql.gz.etg.41-AbCdEf.tmp",
      "backup-2026-01-01.meta.41-AbCdEf.tmp",
      // Names from before temp files carried a per-run token.
      ".backup-conn-2026-01-01-41.txt",
      ".backup-2026-01-01-41.sql",
      ".backup-2026-01-01-41.archive-meta",
      "backup-2026-01-01.sql.gz.tmp",
      "backup-2026-01-01.sql.gz.etg.tmp",
      "backup-2026-01-01.meta.tmp",
    ];
    const fresh = [".backup-2026-01-02-42-GhIjKl.sql", "backup-2026-01-02.sql.gz.42-GhIjKl.tmp"];

    beforeEach(() => {
      mkdirSync(outDir);
      for (const name of stale) {
        writeFileSync(join(outDir, name), "leftover");
        setAgeDays(join(outDir, name), 10);
      }
      for (const name of fresh) {
        writeFileSync(join(outDir, name), "in progress");
        setAgeDays(join(outDir, name), 3);
      }
    });

    it("are swept once past retention", () => {
      const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key" });

      expect(result.status).toBe(0);
      const files = listOut();
      for (const name of stale) expect(files).not.toContain(name);
      for (const name of fresh) expect(files).toContain(name);
      expect(files).toHaveLength(fresh.length + 2);
    });

    it("are swept even when the run itself fails", () => {
      const result = runBackup({ BACKUP_ARCHIVE_ENCRYPTION: "storage-key", STUB_PG_FAIL: "1" });

      expect(result.status).not.toBe(0);
      expect(listOut()).toEqual([...fresh].sort());
    });
  });
});
