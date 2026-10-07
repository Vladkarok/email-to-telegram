import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs .github/scripts/deploy-app.sh against stub `docker` and `curl` on PATH.
// The stubs keep their state in files under STUB_DIR: which app container
// compose would report ("old", "new", "prev" or none), what /readyz answers,
// and every docker call. Stage bounds and the poll interval are shortened
// through the script's ETG_DEPLOY_* overrides so a run takes a few seconds.

const SCRIPT_SOURCE = resolve(process.cwd(), ".github/scripts/deploy-app.sh");
const REPO = "ghcr.io/vladkarok/email-to-telegram";
const OLD_IMAGE = "sha256:0ld0000000000000000000000000000000000000000000000000000000000000";
const NEW_IMAGE = "sha256:1e10000000000000000000000000000000000000000000000000000000000000";
const RUN_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 40_000;

const DOCKER_STUB = String.raw`#!/usr/bin/env bash
set -u
d=$STUB_DIR
printf 'IMAGE_TAG=%s docker %s\n' "${"$"}{IMAGE_TAG:-}" "$*" >>"$d/calls.log"

cid_of() {
  case $1 in
    old) printf 'aaaaaaaaaaaa%052d\n' 0 ;;
    new) printf 'bbbbbbbbbbbb%052d\n' 0 ;;
    prev) printf 'cccccccccccc%052d\n' 0 ;;
  esac
}
name_of() {
  case $1 in
    aaaaaaaaaaaa*) echo old ;;
    bbbbbbbbbbbb*) echo new ;;
    cccccccccccc*) echo prev ;;
  esac
}
current=$(cat "$d/current" 2>/dev/null)

if [[ $1 == compose ]]; then
  shift
  while [[ $1 == --env-file ]]; do shift 2; done
  sub=$1
  shift
  case $sub in
    ps)
      if [[ " $* " != *" -a "* && $current == new && -n ${"$"}{STUB_PS_EMPTY:-} ]]; then exit 0; fi
      [[ -z $current ]] || cid_of "$current"
      exit 0
      ;;
    pull)
      [[ ${"$"}{STUB_PULL:-ok} == ok ]] || { echo "pull failed" >&2; exit 1; }
      exit 0
      ;;
    run)
      [[ -z ${"$"}{STUB_MIGRATE_SLEEP:-} ]] || sleep "$STUB_MIGRATE_SLEEP"
      case ${"$"}{STUB_MIGRATE:-ok} in
        fail) echo "migration error" >&2; exit 3 ;;
        hang) exec sleep 30 ;;
      esac
      echo "migrations applied"
      exit 0
      ;;
    up)
      if [[ $IMAGE_TAG == deploy-previous ]]; then
        mode=${"$"}{STUB_ROLLBACK_UP:-ok}; target=prev
      else
        mode=${"$"}{STUB_UP:-ok}; target=new
      fi
      # Nothing changed: compose keeps the running container.
      [[ -z ${"$"}{STUB_UP_KEEP:-} ]] || exit 0
      # The old container stops first: /readyz is down from here.
      echo 000 >"$d/http"
      [[ $mode != hang ]] || exec sleep 30
      sleep "${"$"}{STUB_UP_SLEEP:-0}"
      if [[ $mode == fail ]]; then
        : >"$d/current"
        echo "compose up failed" >&2
        exit 1
      fi
      echo "$target" >"$d/current"
      exit 0
      ;;
  esac
  echo "unexpected compose call: $sub" >&2
  exit 99
fi

case $1 in
  inspect)
    fmt=$3
    name=$(name_of "$4")
    if [[ $fmt == *Config.Image* ]]; then
      echo "$REPO:v1.0.0 $STUB_OLD_IMAGE ${"$"}{STUB_OLD_STATE:-running} ${"$"}{STUB_OLD_RESTARTS:-0}"
      exit 0
    fi
    case $name in
      new) seq=${"$"}{STUB_NEW_HEALTH:-starting:running:0,healthy:running:0}; probe=${"$"}{STUB_NEW_PROBE:-up} ;;
      prev) seq=${"$"}{STUB_PREV_HEALTH:-healthy:running:0}; probe=up ;;
      old) seq=healthy:${"$"}{STUB_OLD_STATE:-running}:${"$"}{STUB_OLD_RESTARTS:-0}; probe=up ;;
      *) echo "Error: No such object: $4" >&2; exit 1 ;;
    esac
    n=$(cat "$d/inspect-$name" 2>/dev/null || echo 0)
    echo $((n + 1)) >"$d/inspect-$name"
    IFS=, read -r -a tokens <<<"$seq"
    ((n < ${"$"}{#tokens[@]})) || n=$((${"$"}{#tokens[@]} - 1))
    token=${"$"}{tokens[$n]}
    if [[ $token == error ]]; then echo "Error: No such object: $4" >&2; exit 1; fi
    IFS=: read -r health state restarts <<<"$token"
    if [[ $health == healthy && $probe == up ]]; then echo 200 >"$d/http"; fi
    echo "$health $state $restarts"
    ;;
  image)
    if [[ $5 == *:deploy-previous ]]; then echo "$STUB_OLD_IMAGE"; else echo "${"$"}{STUB_TARGET_IMAGE:-$NEW_IMAGE}"; fi
    ;;
  container)
    if [[ -n ${"$"}{STUB_MIGRATE_LEFTOVER:-} ]]; then echo "[{}]"; exit 0; fi
    echo "Error: No such container: $3" >&2
    exit 1
    ;;
  tag | rm) ;;
  logs) echo "app log line from $(name_of "$4")" ;;
  *) echo "unexpected docker call: $1" >&2; exit 99 ;;
esac
`;

const CURL_STUB = String.raw`#!/usr/bin/env bash
d=$STUB_DIR
for arg in "$@"; do last=$arg; done
echo "$last" >"$d/curl-url"
code=""
if [[ -s $d/curl-seq ]]; then
  code=$(head -n 1 "$d/curl-seq")
  tail -n +2 "$d/curl-seq" >"$d/curl-seq.next"
  mv "$d/curl-seq.next" "$d/curl-seq"
fi
[[ -n $code ]] || code=$(cat "$d/http" 2>/dev/null || echo 000)
printf '%s' "$code"
[[ $code != 000 ]] || exit 7
`;

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  out: string;
  stdout: string;
  calls: string[];
}

let root: string;
let appDir: string;
let stubDir: string;
let binDir: string;
let runId: string;

function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    HOME: root,
    TMPDIR: root,
    STUB_DIR: stubDir,
    STUB_OLD_IMAGE: OLD_IMAGE,
    REPO,
    NEW_IMAGE,
    ETG_TEST_RUN: runId,
    IMAGE_TAG: "v1.1.0",
    DEPLOY_TOOLING_COMMIT: "abc1234",
    ETG_DEPLOY_POLL_INTERVAL: "0.1",
    ETG_DEPLOY_MIGRATE_TIMEOUT: "1",
    ETG_DEPLOY_REPLACE_TIMEOUT: "5",
    ETG_DEPLOY_HEALTH_TIMEOUT: "2",
    // Each replacement keeps /readyz down for a few probe intervals.
    STUB_UP_SLEEP: "0.3",
    ...extra,
  };
}

// An old app container that is running and answering, unless the case says
// there is none.
function setState({ oldApp = true }: { oldApp?: boolean } = {}): void {
  writeFileSync(join(stubDir, "current"), oldApp ? "old\n" : "");
  writeFileSync(join(stubDir, "http"), oldApp ? "200\n" : "000\n");
}

function calls(): string[] {
  const file = join(stubDir, "calls.log");
  return existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n") : [];
}

function deploy(extra: Record<string, string> = {}): Run {
  const result = spawnSync("bash", [join(appDir, "deploy-app.sh")], {
    env: scriptEnv(extra),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    status: result.status,
    signal: result.signal,
    out: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
    calls: calls(),
  };
}

// Processes that carry this test's marker in their environment: the script,
// its probe, the stubs and anything they started.
function survivors(): string[] {
  const found: string[] = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf-8").includes(`ETG_TEST_RUN=${runId}`)) {
        found.push(pid);
      }
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

function upCalls(run: Run): string[] {
  return run.calls.filter((call) => / docker compose --env-file \.env up /.test(call));
}

const ROLLBACK_UP = "IMAGE_TAG=deploy-previous docker compose --env-file .env up -d --no-build";
const MIGRATE_RUN =
  "docker compose --env-file .env run --rm --no-deps -T --name etg-migrate app node dist/index.js --migrate-only";

function expectRolledBack(run: Run): void {
  expect(run.status).toBe(1);
  expect(run.calls).toContain(`IMAGE_TAG=v1.1.0 docker tag ${OLD_IMAGE} ${REPO}:deploy-previous`);
  expect(run.calls).toContain(ROLLBACK_UP);
  expect(run.out).toContain(`Rolled back to ${OLD_IMAGE}.`);
  expect(run.out).toContain("time to healthy (rollback): ");
  expect(run.out).not.toContain("rollback failed");
}

function lastLine(run: Run): string | undefined {
  return run.stdout.trim().split("\n").at(-1);
}

function downLines(run: Run): string[] {
  return run.out.split("\n").filter((line) => line.startsWith("down "));
}

describe.skipIf(process.platform !== "linux")(".github/scripts/deploy-app.sh", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "email-to-telegram-deploy-app-"));
    appDir = join(root, "email-to-telegram");
    stubDir = join(root, "stub");
    binDir = join(root, "bin");
    for (const dir of [appDir, stubDir, binDir]) mkdirSync(dir);
    copyFileSync(SCRIPT_SOURCE, join(appDir, "deploy-app.sh"));
    writeFileSync(join(appDir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(
      join(appDir, ".env"),
      [
        "# a comment",
        "TELEGRAM_BOT_TOKEN=123456:do-not-print-me",
        'HOST_BIND_IP="10.0.88.2" # private interface',
        "POSTGRES_PASSWORD='also-secret'",
        "",
      ].join("\r\n"),
    );
    writeFileSync(join(binDir, "docker"), DOCKER_STUB);
    writeFileSync(join(binDir, "curl"), CURL_STUB);
    chmodSync(join(binDir, "docker"), 0o755);
    chmodSync(join(binDir, "curl"), 0o755);
    runId = randomUUID();
    setState();
  });

  afterEach(() => {
    expect(survivors()).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "deploys: migrates first, replaces, waits for healthy and ready, reports",
    () => {
      const run = deploy();

      expect(run.status).toBe(0);
      expect(run.out).toContain("tooling commit abc1234, target " + `${REPO}:v1.1.0`);
      expect(run.out).toContain(`image ${OLD_IMAGE}, state running, restarts 0`);
      const migrate = run.calls.findIndex((call) => call.endsWith(MIGRATE_RUN));
      const up = run.calls.indexOf(
        "IMAGE_TAG=v1.1.0 docker compose --env-file .env up -d --remove-orphans --no-build",
      );
      expect(migrate).toBeGreaterThan(-1);
      expect(up).toBeGreaterThan(migrate);
      expect(run.calls).not.toContain(ROLLBACK_UP);
      expect(readFileSync(join(stubDir, "curl-url"), "utf-8").trim()).toBe(
        "http://10.0.88.2:3000/readyz",
      );
      expect(run.out).toMatch(/migration done in \d+\.\d s/);
      expect(run.out).toMatch(/migration: done in \d+\.\d s/);
      expect(run.out).toMatch(/time to healthy: \d+\.\d s after replacement started/);
      expect(downLines(run)).toHaveLength(1);
      expect(run.out).toMatch(/total down: \d+\.\d s in 1 interval/);
      expect(run.out).not.toContain("not recovered");
      expect(lastLine(run)).toBe(`deployed ${REPO}:v1.1.0 (${NEW_IMAGE})`);
      // Nothing from .env but HOST_BIND_IP, and the work directory is gone.
      expect(run.out).not.toContain("do-not-print-me");
      expect(run.out).not.toContain("also-secret");
      expect(readdirSync(root).filter((name) => name.startsWith("etg-deploy."))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replaces nothing when the migration fails",
    () => {
      const run = deploy({ STUB_MIGRATE: "fail" });

      expect(run.status).toBe(1);
      expect(upCalls(run)).toEqual([]);
      expect(run.out).toContain("migration: failed (exit 3)");
      expect(run.out).toContain("replacement: not started");
      expect(run.out).toContain("---- availability report");
      expect(lastLine(run)).toBe(
        "migration failed (exit 3). Nothing was replaced; the running app keeps serving.",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "replaces nothing and says the outcome is unknown when the migration times out",
    () => {
      const run = deploy({ STUB_MIGRATE: "hang" });

      expect(run.status).toBe(1);
      expect(upCalls(run)).toEqual([]);
      expect(run.calls).toContain("IMAGE_TAG=v1.1.0 docker rm -f etg-migrate");
      expect(run.out).toMatch(/migration: timed out after \d+\.\d s/);
      expect(run.out).toContain("migration outcome unknown: it may have committed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "changes nothing when the pull fails",
    () => {
      const run = deploy({ STUB_PULL: "fail" });

      expect(run.status).toBe(1);
      expect(run.out).toContain("ERROR: pull failed or timed out; nothing changed");
      expect(
        run.calls.some((call) => / docker (tag|compose --env-file \.env (run|up)) /.test(call)),
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops before migrating when a migrate container is left from an earlier run",
    () => {
      const run = deploy({ STUB_MIGRATE_LEFTOVER: "1" });

      expect(run.status).toBe(1);
      expect(run.calls.some((call) => call.endsWith(MIGRATE_RUN))).toBe(false);
      expect(upCalls(run)).toEqual([]);
      expect(run.out).toContain("a container named etg-migrate is left from an earlier run");
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["a compose-up error", { STUB_UP: "fail" }, "compose up failed (exit 1)"],
    [
      "a compose-up timeout",
      { STUB_UP: "hang", ETG_DEPLOY_REPLACE_TIMEOUT: "1" },
      "compose up timed out",
    ],
    ["a missing container ID", { STUB_PS_EMPTY: "1" }, "no app container ID after compose up"],
    ["an inspect error", { STUB_NEW_HEALTH: "starting:running:0,error" }, "docker inspect failed"],
    [
      "a restarting container",
      { STUB_NEW_HEALTH: "starting:restarting:1" },
      "the app container is restarting",
    ],
    [
      "an exited container",
      { STUB_NEW_HEALTH: "starting:exited:0" },
      "the app container is exited",
    ],
    [
      "a restart count above zero",
      { STUB_NEW_HEALTH: "starting:running:1" },
      "the app container restarted (1)",
    ],
    [
      "an unhealthy container",
      { STUB_NEW_HEALTH: "unhealthy:running:0" },
      "Docker reports the app container unhealthy",
    ],
    [
      "a container never healthy",
      { STUB_NEW_HEALTH: "starting:running:0" },
      "not healthy and ready within 2s",
    ],
    [
      "healthy but the probe down",
      { STUB_NEW_PROBE: "down" },
      "not healthy and ready within 2s (Docker: healthy, probe: 000)",
    ],
  ] as const)(
    "rolls back to the previous image after %s",
    (_name, extra, reason) => {
      const run = deploy(extra);

      expectRolledBack(run);
      expect(run.out).toContain(`deploy failed: ${reason}`);
      // The stub's failed compose up leaves no container to read logs from.
      if (!("STUB_UP" in extra)) {
        expect(run.out).toContain("---- last 200 log lines of the app container bbbbbbbbbbbb");
      }
      expect(run.out).not.toContain("not recovered");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "prints the time to healthy of a release that turned healthy but never ready",
    () => {
      const run = deploy({ STUB_NEW_PROBE: "down" });

      expect(run.out).toMatch(/time to healthy: \d+\.\d s after replacement started/);
      expect(run.out).toMatch(/time to healthy \(rollback\): \d+\.\d s after the rollback started/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not roll back when there is no previous image",
    () => {
      setState({ oldApp: false });
      const run = deploy({ STUB_UP: "fail" });

      expect(run.status).toBe(1);
      expect(run.out).toContain("running app container: none");
      expect(run.calls.some((call) => call.includes(" docker tag "))).toBe(false);
      expect(upCalls(run)).toHaveLength(1);
      expect(run.out).toContain("No previous image (first deploy): not rolled back");
      expect(run.out).toContain("not recovered");
      expect(run.out).toContain("time to healthy: never healthy");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not roll back to the same image",
    () => {
      const run = deploy({ STUB_TARGET_IMAGE: OLD_IMAGE, STUB_UP: "fail" });

      expect(run.status).toBe(1);
      expect(upCalls(run)).toHaveLength(1);
      expect(run.out).toContain(
        `The previous image is the same image (${OLD_IMAGE}): not rolled back`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits with rollback failed when the rollback fails too",
    () => {
      const run = deploy({ STUB_UP: "fail", STUB_ROLLBACK_UP: "fail" });

      expect(run.status).toBe(1);
      expect(run.calls).toContain(ROLLBACK_UP);
      expect(run.out).toContain("not recovered");
      expect(lastLine(run)).toBe(
        "rollback failed: compose up failed (exit 1). The deploy failed first: compose up failed (exit 1). The host is left as is.",
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits with rollback failed when the previous image does not get healthy either",
    () => {
      const run = deploy({ STUB_UP: "fail", STUB_PREV_HEALTH: "starting:restarting:2" });

      expect(run.status).toBe(1);
      expect(run.out).toContain("rollback failed: the app container is restarting");
      expect(run.out).toContain("not recovered");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports two separate down intervals",
    () => {
      // One failed probe while the migration runs, then the replacement gap.
      writeFileSync(join(stubDir, "curl-seq"), "000\n");
      const run = deploy({ STUB_MIGRATE_SLEEP: "0.6" });

      expect(run.status).toBe(0);
      const down = downLines(run);
      expect(down).toHaveLength(2);
      for (const line of down) {
        expect(line).toMatch(/^down \d\d:\d\d:\d\d -> \d\d:\d\d:\d\d \(\d+\.\d s\)$/);
      }
      expect(run.out).toMatch(/total down: \d+\.\d s in 2 interval\(s\)/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "marks the report unreliable when /readyz answers 429",
    () => {
      writeFileSync(join(stubDir, "curl-seq"), "429\n");
      const run = deploy({ STUB_MIGRATE_SLEEP: "0.3" });

      expect(run.status).toBe(0);
      expect(run.out).toContain("unreliable: /readyz answered 429");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "warns about a restarting app container before changing anything",
    () => {
      const run = deploy({ STUB_OLD_STATE: "restarting", STUB_OLD_RESTARTS: "7" });

      expect(run.out).toContain("state restarting, restarts 7");
      expect(run.out).toContain("WARNING: the app container is restarting or has restarted.");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not count restarts from before the deploy when compose keeps the container",
    () => {
      const run = deploy({
        STUB_TARGET_IMAGE: OLD_IMAGE,
        STUB_UP_KEEP: "1",
        STUB_OLD_RESTARTS: "2",
      });

      expect(run.status).toBe(0);
      expect(run.out).toContain("never down");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses to start without HOST_BIND_IP in .env",
    () => {
      writeFileSync(join(appDir, ".env"), "HOST_BIND_IP=\nOTHER=1\n");
      const run = deploy();

      expect(run.status).toBe(1);
      expect(run.out).toContain("ERROR: HOST_BIND_IP in .env is missing or not an IP address");
      expect(run.calls).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)(
    "stops the probe and does not roll back on %s",
    async (signal, exitCode) => {
      const child = spawn("bash", [join(appDir, "deploy-app.sh")], {
        env: scriptEnv({ STUB_NEW_HEALTH: "starting:running:0", ETG_DEPLOY_HEALTH_TIMEOUT: "20" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.setEncoding("utf-8").on("data", (chunk: string) => (out += chunk));
      child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (out += chunk));
      const exit = new Promise<number | null>((resolveExit) => {
        child.on("close", (code) => resolveExit(code));
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!calls().some((call) => call.includes("docker inspect --format {{if"))) {
          if (Date.now() > deadline) throw new Error(`the health wait never started: ${out}`);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
        }
        child.kill(signal);
        expect(await exit).toBe(exitCode);
        expect(calls()).not.toContain(ROLLBACK_UP);
        expect(out).toContain(
          `interrupted by ${signal} during the replace stage: no automatic rollback`,
        );
        expect(out).toContain("---- availability report");
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exit;
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
