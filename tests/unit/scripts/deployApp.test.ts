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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs .github/scripts/deploy-app.sh against stub `docker` and `curl` on PATH.
// The stubs keep their state in files under STUB_DIR: which app container
// compose would report ("old", "new", "prev" or none), what /readyz answers,
// every docker call, and the first line of each compose file an app `up` got. Stage bounds and the poll interval are shortened
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
# What the app prints: configuration from .env, a raw fatal error, JSON errors.
app_output() {
  echo '{"level":30,"msg":"plan limits","PLAN_LIMIT_OVERRIDES":"plan-secret-value"}'
  echo 'Fatal error during startup: TELEGRAM_BOT_TOKEN=raw-secret-value'
  echo '{"level":50,"time":1,"msg":"'"$1"'","err":{"type":"Error","message":"pw=err-secret-value","code":"42P01"}}'
}
current=$(cat "$d/current" 2>/dev/null)

if [[ $1 == compose ]]; then
  shift
  files=""
  while [[ $1 == --env-file || $1 == -f ]]; do
    [[ $1 != -f ]] || files+=" $2"
    shift 2
  done
  sub=$1
  shift
  case $sub in
    config)
      if [[ -n ${"$"}{STUB_CONFIG_FAIL:-} && " $files " == *" $STUB_CONFIG_FAIL "* ]]; then
        echo "failed to read .env: line 2: TELEGRAM_BOT_TOKEN=123456:do-not-print-me" >&2
        exit 15
      fi
      exit 0
      ;;
    ps)
      [[ -z ${"$"}{STUB_PS_WARN:-} ]] || echo 'WARN[0000] The "FOO" variable is not set. Defaulting to a blank string.' >&2
      case ${"$"}{STUB_PS_HANG:-} in
        all) exec sleep 30 ;;
        after-up) [[ $current != new ]] || exec sleep 30 ;;
      esac
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
        fail) app_output "migration failed"; exit 3 ;;
        hang) exec sleep 30 ;;
      esac
      echo '{"level":30,"msg":"plan limits","PLAN_LIMIT_OVERRIDES":"plan-secret-value"}'
      echo '{"level":30,"msg":"Migrations complete."}'
      exit 0
      ;;
    up)
      if [[ ${"$"}{!#} == postgres ]]; then
        case ${"$"}{STUB_DB_UP:-ok} in
          fail) echo "dependency failed to start" >&2; exit 1 ;;
          hang) exec sleep 30 ;;
        esac
        exit 0
      fi
      echo "${"$"}{HOST_BIND_IP:-}" >"$d/up-bind-ip"
      for f in $files; do printf '%s %s: %s\n' "$IMAGE_TAG" "$f" "$(head -n 1 "$f")"; done >>"$d/up-files"
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
      new)
        seq=${"$"}{STUB_NEW_HEALTH:-starting:running:0,healthy:running:0}; probe=${"$"}{STUB_NEW_PROBE:-up}
        image=${"$"}{STUB_NEW_CONTAINER_IMAGE:-${"$"}{STUB_TARGET_IMAGE:-$NEW_IMAGE}}
        ;;
      prev)
        seq=${"$"}{STUB_PREV_HEALTH:-healthy:running:0}; probe=up
        image=${"$"}{STUB_PREV_CONTAINER_IMAGE:-$STUB_OLD_IMAGE}
        ;;
      old)
        seq=healthy:${"$"}{STUB_OLD_STATE:-running}:${"$"}{STUB_OLD_RESTARTS:-0}; probe=up
        image=$STUB_OLD_IMAGE
        ;;
      *) echo "Error: No such object: $4" >&2; exit 1 ;;
    esac
    n=$(cat "$d/inspect-$name" 2>/dev/null || echo 0)
    echo $((n + 1)) >"$d/inspect-$name"
    IFS=, read -r -a tokens <<<"$seq"
    ((n < ${"$"}{#tokens[@]})) || n=$((${"$"}{#tokens[@]} - 1))
    token=${"$"}{tokens[$n]}
    if [[ $token == error ]]; then echo "Error: No such object: $4" >&2; exit 1; fi
    [[ $token != hang ]] || exec sleep 30
    # health:state:restarts[@seconds to wait before answering]
    delay=""
    if [[ $token == *@* ]]; then delay=${"$"}{token#*@}; token=${"$"}{token%@*}; fi
    IFS=: read -r health state restarts <<<"$token"
    if [[ $health == healthy && $probe == up ]]; then echo 200 >"$d/http"; fi
    [[ -z $delay ]] || sleep "$delay"
    echo "$health $state $restarts $image"
    ;;
  image)
    if [[ $5 == *:deploy-previous ]]; then echo "$STUB_OLD_IMAGE"; exit 0; fi
    n=$(cat "$d/image-inspect" 2>/dev/null || echo 0)
    echo $((n + 1)) >"$d/image-inspect"
    # STUB_TAG_MOVES: another pull moved the tag after the deploy's own.
    if [[ -n ${"$"}{STUB_TAG_MOVES:-} ]] && ((n >= 1)); then echo "$STUB_TAG_MOVES"; exit 0; fi
    echo "${"$"}{STUB_TARGET_IMAGE:-$NEW_IMAGE}"
    ;;
  container)
    if [[ -n ${"$"}{STUB_MIGRATE_LEFTOVER:-} ]]; then echo "[{}]"; exit 0; fi
    echo "Error: No such container: $3" >&2
    exit 1
    ;;
  tag) ;;
  rm) [[ ${"$"}{STUB_RM:-ok} != hang ]] || exec sleep 30 ;;
  logs)
    [[ ${"$"}{STUB_LOGS:-ok} != hang ]] || exec sleep 30
    app_output "app error from $(name_of "$4")"
    ;;
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

// umask: run the script from a shell with this umask instead of the test's.
function deploy(extra: Record<string, string> = {}, { umask }: { umask?: string } = {}): Run {
  const script = join(appDir, "deploy-app.sh");
  const args = umask ? ["-c", `umask ${umask} && exec bash "$0"`, script] : [script];
  const result = spawnSync("bash", args, {
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

// IMAGE_TAG, file and first line of each compose file the app `up` calls got.
function upFiles(): string[] {
  const file = join(stubDir, "up-files");
  return existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n") : [];
}

// App replacements and rollbacks: compose up calls other than the database's.
function upCalls(run: Run): string[] {
  return run.calls.filter(
    (call) =>
      / docker compose (-f \S+ )*--env-file \.env up /.test(call) && !call.endsWith(" postgres"),
  );
}

const MAIN = "docker-compose.yml";
const CANDIDATE = "docker-compose.next.yml";
const RUNNING_COMPOSE = "services: {} # the running release\n";
const DEPLOY_UP = `IMAGE_TAG=v1.1.0 docker compose -f ${MAIN} --env-file .env up -d --remove-orphans --no-build --pull never`;
const ROLLBACK_UP = `IMAGE_TAG=deploy-previous docker compose -f ${MAIN} --env-file .env up -d --no-build --pull never`;
const DB_UP = `IMAGE_TAG=v1.1.0 docker compose -f ${MAIN} --env-file .env up -d --wait --no-recreate postgres`;
const MIGRATE_RUN = `docker compose -f ${MAIN} --env-file .env run --rm --no-deps --pull never -T --name etg-migrate app node dist/index.js --migrate-only`;
const CONFIG = `IMAGE_TAG=v1.1.0 docker compose -f ${MAIN} --env-file .env config -q`;
const SECRETS = [
  "do-not-print-me",
  "also-secret",
  "plan-secret-value",
  "raw-secret-value",
  "err-secret-value",
];

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

// Every file under DIR, recursively.
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

// The host-local copies in deploy-logs/: the run log and kept outputs.
function hostLogs(): Record<string, string> {
  const dir = join(appDir, "deploy-logs");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf-8")]),
  );
}

function runLog(): string {
  const entries = Object.entries(hostLogs()).filter(([name]) =>
    /^\d{8}T\d{6}Z-\d+\.log$/.test(name),
  );
  expect(entries).toHaveLength(1);
  return entries[0][1];
}

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
    writeFileSync(join(appDir, MAIN), RUNNING_COMPOSE);
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
      const db = run.calls.indexOf(DB_UP);
      const up = run.calls.indexOf(DEPLOY_UP);
      expect(db).toBeGreaterThan(-1);
      expect(migrate).toBeGreaterThan(db);
      expect(up).toBeGreaterThan(migrate);
      expect(run.calls).toContain(CONFIG);
      expect(run.calls).not.toContain(ROLLBACK_UP);
      expect(readFileSync(join(stubDir, "curl-url"), "utf-8").trim()).toBe(
        "http://10.0.88.2:3000/readyz",
      );
      expect(run.out).toMatch(/migration exited 0 after \d+\.\d s/);
      expect(run.out).toMatch(/migration: done in \d+\.\d s/);
      expect(run.out).toMatch(/time to healthy: \d+\.\d s after replacement started/);
      expect(downLines(run)).toHaveLength(1);
      expect(run.out).toMatch(/total down: \d+\.\d s in 1 interval/);
      expect(run.out).not.toContain("not recovered");
      expect(lastLine(run)).toBe(`deployed ${REPO}:v1.1.0 (${NEW_IMAGE})`);
      // Nothing from .env but HOST_BIND_IP, no app output, and the work
      // directory is gone.
      expectNoSecrets(run.out);
      expect(run.out).not.toContain("Migrations complete.");
      expect(readdirSync(root).filter((name) => name.startsWith("etg-deploy."))).toEqual([]);
      // The host keeps the same output.
      expect(runLog()).toContain(`deployed ${REPO}:v1.1.0 (${NEW_IMAGE})`);
      expect(run.out).toContain(`full log on the host: ${join(appDir, "deploy-logs")}/`);
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
      // Only the error line's msg and code reach the job log; the full
      // output stays on the host.
      expect(run.out).toContain("level 50: migration failed (code 42P01)");
      expectNoSecrets(run.out);
      expectNoSecrets(runLog());
      const kept = Object.entries(hostLogs()).find(([name]) => name.endsWith(".migrate.log"));
      expect(kept?.[1]).toContain("raw-secret-value");
      expect(run.out).toContain(
        `full output on the host: ${join(appDir, "deploy-logs", kept?.[0] ?? "")}`,
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
        run.calls.some((call) =>
          / docker (tag|compose (-f \S+ )*--env-file \.env (run|up)) /.test(call),
        ),
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
        expect(run.out).toContain("---- app container bbbbbbbbbbbb");
        expect(run.out).toContain("level 50: app error from new (code 42P01)");
        expectNoSecrets(run.out);
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

  describe("bounded Docker calls", () => {
    it(
      "fails before changing anything when compose ps hangs",
      () => {
        const run = deploy({ STUB_PS_HANG: "all", ETG_DEPLOY_CALL_TIMEOUT: "1" });

        expect(run.status).toBe(1);
        expect(lastLine(run)).toBe("ERROR: docker compose ps failed or timed out; nothing changed");
        expect(
          run.calls.some((call) => / docker compose (-f \S+ )*--env-file \.env pull /.test(call)),
        ).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rolls back when compose ps hangs after compose up",
      () => {
        const run = deploy({ STUB_PS_HANG: "after-up", ETG_DEPLOY_CALL_TIMEOUT: "1" });

        expectRolledBack(run);
        expect(run.out).toContain("deploy failed: compose ps timed out after 1s");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rolls back when docker inspect hangs, bounded by the health stage",
      () => {
        const run = deploy({ STUB_NEW_HEALTH: "starting:running:0,hang" });

        expectRolledBack(run);
        expect(run.out).toMatch(/deploy failed: docker inspect timed out after [12]s/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "does not count a healthy answer that arrives after the health deadline",
      () => {
        const run = deploy({
          ETG_DEPLOY_HEALTH_TIMEOUT: "1",
          STUB_NEW_HEALTH: "starting:running:0@0.5,healthy:running:0@0.9",
        });

        expect(run.status).toBe(1);
        expect(run.out).toContain(
          "deploy failed: not healthy and ready within 1s (Docker: healthy",
        );
        expect(run.out).toContain("time to healthy: never healthy");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rolls back even when docker logs hangs",
      () => {
        const run = deploy({
          STUB_NEW_HEALTH: "unhealthy:running:0",
          STUB_LOGS: "hang",
          ETG_DEPLOY_CALL_TIMEOUT: "1",
        });

        expectRolledBack(run);
        expect(run.out).toContain("did not answer within 1s; skipped");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "finishes when removing a timed-out migrate container hangs",
      () => {
        const run = deploy({
          STUB_MIGRATE: "hang",
          STUB_RM: "hang",
          ETG_DEPLOY_CALL_TIMEOUT: "1",
        });

        expect(run.status).toBe(1);
        expect(run.calls).toContain("IMAGE_TAG=v1.1.0 docker rm -f etg-migrate");
        expect(lastLine(run)).toBe(
          "migration outcome unknown: it may have committed. Nothing was replaced; the running app keeps serving.",
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("unexpected exit and a lost session", () => {
    it(
      "rolls back after an unexpected exit during the replace stage",
      () => {
        // The first health-loop sleep of the replace stage exits the script.
        const hook = join(root, "bash-env");
        writeFileSync(
          hook,
          'sleep() { if [[ ${phase:-} == replace ]]; then exit 7; fi; command sleep "$@"; }\n',
        );
        const run = deploy({ BASH_ENV: hook });

        expectRolledBack(run);
        expect(run.out).toContain(
          "deploy failed: unexpected exit (status 7) during the replace stage",
        );
        expect(run.out).toMatch(/time to healthy \(rollback\): \d+\.\d s/);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "deploys and keeps the report on the host when the job's stdout is closed",
      async () => {
        const child = spawn("bash", [join(appDir, "deploy-app.sh")], {
          env: scriptEnv({}),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.destroy();
        let err = "";
        child.stderr.setEncoding("utf-8").on("data", (chunk: string) => (err += chunk));
        const code = await new Promise<number | null>((resolveExit) => {
          child.on("close", (status) => resolveExit(status));
        });

        expect(code).toBe(0);
        expect(err).toBe("");
        const log = runLog();
        expect(log).toContain("---- availability report");
        expect(log.trim().split("\n").at(-1)).toBe(`deployed ${REPO}:v1.1.0 (${NEW_IMAGE})`);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "keeps only the newest host logs",
      () => {
        const dir = join(appDir, "deploy-logs");
        mkdirSync(dir);
        for (let i = 0; i < 40; i++) {
          writeFileSync(join(dir, `20200101T0000${String(i).padStart(2, "0")}Z-1.log`), "old\n");
        }
        const run = deploy();

        expect(run.status).toBe(0);
        const names = Object.keys(hostLogs()).sort();
        expect(names).toHaveLength(30);
        expect(names.at(-1)).toMatch(/^\d{8}T\d{6}Z-\d+\.log$/);
        expect(names[0]).toBe("20200101T000011Z-1.log");
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("the image that runs", () => {
    it(
      "never lets compose run or up pull",
      () => {
        const run = deploy();

        expect(run.calls.some((call) => call.endsWith(MIGRATE_RUN))).toBe(true);
        expect(run.calls).toContain(DEPLOY_UP);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "replaces nothing when the tag moved after the pull",
      () => {
        const moved = "sha256:c0ffee0000000000000000000000000000000000000000000000000000000000";
        const run = deploy({ STUB_TAG_MOVES: moved });

        expect(run.status).toBe(1);
        expect(run.calls.some((call) => call.endsWith(MIGRATE_RUN))).toBe(false);
        expect(upCalls(run)).toEqual([]);
        expect(lastLine(run)).toBe(
          `ERROR: ${REPO}:v1.1.0 now names ${moved}, not the pulled ${NEW_IMAGE}; nothing was replaced`,
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rolls back when the new container runs another image than the one pulled",
      () => {
        const other = "sha256:0e1e000000000000000000000000000000000000000000000000000000000000";
        const run = deploy({ STUB_NEW_CONTAINER_IMAGE: other });

        expectRolledBack(run);
        expect(run.out).toContain(
          `deploy failed: the app container runs image ${other}, not ${NEW_IMAGE}`,
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "fails the rollback when the rolled-back container runs another image",
      () => {
        const other = "sha256:0e1e000000000000000000000000000000000000000000000000000000000000";
        const run = deploy({ STUB_UP: "fail", STUB_PREV_CONTAINER_IMAGE: other });

        expect(run.status).toBe(1);
        expect(run.out).toContain(
          `rollback failed: the app container runs image ${other}, not ${OLD_IMAGE}`,
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("HOST_BIND_IP", () => {
    it(
      "refuses a shell value that differs from .env",
      () => {
        const run = deploy({ HOST_BIND_IP: "10.0.99.9" });

        expect(run.status).toBe(1);
        expect(lastLine(run)).toBe(
          "ERROR: HOST_BIND_IP in the environment differs from the one in .env; unset it or make them agree",
        );
        expect(run.calls).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "gives Compose the value the probe uses",
      () => {
        const run = deploy({ HOST_BIND_IP: "10.0.88.2" });

        expect(run.status).toBe(0);
        expect(readFileSync(join(stubDir, "up-bind-ip"), "utf-8").trim()).toBe("10.0.88.2");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "exports the .env value when the shell has none",
      () => {
        const run = deploy();

        expect(run.status).toBe(0);
        expect(readFileSync(join(stubDir, "up-bind-ip"), "utf-8").trim()).toBe("10.0.88.2");
      },
      TEST_TIMEOUT_MS,
    );
  });

  it(
    "hides compose output when it cannot read .env, before any other compose call",
    () => {
      const run = deploy({ STUB_CONFIG_FAIL: MAIN });

      expect(run.status).toBe(1);
      expect(run.calls).toEqual([CONFIG]);
      expect(lastLine(run)).toContain(
        "ERROR: docker compose cannot read docker-compose.yml with .env",
      );
      expectNoSecrets(run.out);
      expectNoSecrets(runLog());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores a Compose warning in the ps output",
    () => {
      const run = deploy({ STUB_PS_WARN: "1" });

      expect(run.status).toBe(0);
      expect(run.out).toContain("running app container aaaaaaaaaaaa");
    },
    TEST_TIMEOUT_MS,
  );

  describe("the database before the migration", () => {
    it(
      "replaces nothing when the database does not start",
      () => {
        const run = deploy({ STUB_DB_UP: "fail" });

        expect(run.status).toBe(1);
        expect(run.calls.some((call) => call.endsWith(MIGRATE_RUN))).toBe(false);
        expect(upCalls(run)).toEqual([]);
        expect(run.out).toContain("migration: not run: the database did not start");
        expect(lastLine(run)).toBe(
          "the database did not start (exit 1). Nothing was replaced; the running app keeps serving.",
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "counts the database wait in the migrate bound",
      () => {
        const run = deploy({ STUB_DB_UP: "hang" });

        expect(run.status).toBe(1);
        expect(run.calls.some((call) => call.endsWith(MIGRATE_RUN))).toBe(false);
        expect(lastLine(run)).toBe(
          "the database was not healthy within 1s. Nothing was replaced; the running app keeps serving.",
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "does not claim a running app when there is none",
      () => {
        setState({ oldApp: false });
        const run = deploy({ STUB_MIGRATE: "fail" });

        expect(lastLine(run)).toBe(
          "migration failed (exit 3). Nothing was replaced; no app was running before this deploy.",
        );
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("the candidate compose file", () => {
    const candidatePath = (): string => join(appDir, CANDIDATE);
    const mainText = (): string => readFileSync(join(appDir, MAIN), "utf-8");

    it(
      "deploys with the candidate and renames it to docker-compose.yml once verified",
      () => {
        writeFileSync(candidatePath(), "services: {} # next\n");
        const run = deploy();

        expect(run.status).toBe(0);
        expect(run.calls).toContain(
          `IMAGE_TAG=v1.1.0 docker compose -f ${CANDIDATE} --env-file .env pull app`,
        );
        expect(
          run.calls.some((call) =>
            call.endsWith(MIGRATE_RUN.replace(`-f ${MAIN}`, `-f ${CANDIDATE}`)),
          ),
        ).toBe(true);
        expect(upFiles()).toEqual([`v1.1.0 ${CANDIDATE}: services: {} # next`]);
        expect(mainText()).toBe("services: {} # next\n");
        expect(existsSync(candidatePath())).toBe(false);
        expect(lastLine(run)).toBe(`deployed ${REPO}:v1.1.0 (${NEW_IMAGE})`);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "keeps docker-compose.yml for the rollback after a failure before and one after the replacement",
      () => {
        // The first deploy fails at the migration: nothing replaced.
        writeFileSync(candidatePath(), "services: {} # release A\n");
        const first = deploy({ STUB_MIGRATE: "fail" });

        expect(first.status).toBe(1);
        expect(upCalls(first)).toEqual([]);
        expect(mainText()).toBe(RUNNING_COMPOSE);
        expect(existsSync(candidatePath())).toBe(false);
        expect(first.out).toContain(`deleted ${CANDIDATE}; docker-compose.yml is unchanged`);

        // The second one replaces, fails and rolls back with the running
        // release's file, not release A's or its own.
        writeFileSync(candidatePath(), "services: {} # release B\n");
        const second = deploy({ STUB_UP: "fail" });

        expectRolledBack(second);
        expect(upFiles()).toEqual([
          `v1.1.0 ${CANDIDATE}: services: {} # release B`,
          `deploy-previous ${MAIN}: services: {} # the running release`,
        ]);
        expect(second.out).toContain(`rollback: image ${OLD_IMAGE} with ${MAIN}`);
        expect(mainText()).toBe(RUNNING_COMPOSE);
        expect(existsSync(candidatePath())).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it.each([
      [CANDIDATE, "ERROR: docker compose cannot read docker-compose.next.yml with .env"],
      [MAIN, "ERROR: docker compose cannot read docker-compose.yml, which a rollback would use"],
    ])(
      "changes nothing when %s does not parse",
      (file, message) => {
        writeFileSync(candidatePath(), "services: {} # next\n");
        const run = deploy({ STUB_CONFIG_FAIL: file });

        expect(run.status).toBe(1);
        expect(lastLine(run)).toContain(message);
        expect(run.calls.every((call) => call.endsWith(" config -q"))).toBe(true);
        expect(mainText()).toBe(RUNNING_COMPOSE);
        expect(existsSync(candidatePath())).toBe(false);
        expectNoSecrets(run.out);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "deploys the candidate on a host without docker-compose.yml",
      () => {
        setState({ oldApp: false });
        rmSync(join(appDir, MAIN));
        writeFileSync(candidatePath(), "services: {} # first\n");
        const run = deploy();

        expect(run.status).toBe(0);
        expect(mainText()).toBe("services: {} # first\n");
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("the compose file list", () => {
    it(
      "adds the override file Compose would pick to every Compose call, the rollback's included",
      () => {
        // Compose prefers compose.override.yaml to docker-compose.override.yml.
        writeFileSync(join(appDir, "compose.override.yaml"), "services: {}\n");
        writeFileSync(join(appDir, "docker-compose.override.yml"), "services: {}\n");
        const run = deploy({ STUB_UP: "fail" });

        expect(lastLine(run)).toContain(`Rolled back to ${OLD_IMAGE}.`);
        const composeCalls = run.calls.filter((call) => call.includes(" docker compose "));
        expect(composeCalls.length).toBeGreaterThan(5);
        for (const call of composeCalls) {
          expect(call).toContain(
            `docker compose -f ${MAIN} -f compose.override.yaml --env-file .env `,
          );
        }
        expect(upFiles()).toEqual([
          `v1.1.0 ${MAIN}: services: {} # the running release`,
          "v1.1.0 compose.override.yaml: services: {}",
          `deploy-previous ${MAIN}: services: {} # the running release`,
          "deploy-previous compose.override.yaml: services: {}",
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it.each([
      [
        "COMPOSE_FILE in .env",
        () => writeFileSync(join(appDir, ".env"), "HOST_BIND_IP=10.0.88.2\nCOMPOSE_FILE=a.yml\n"),
        {},
        "ERROR: COMPOSE_FILE is set in the environment or .env",
      ],
      [
        "COMPOSE_FILE in the environment",
        () => undefined,
        { COMPOSE_FILE: "a.yml" },
        "ERROR: COMPOSE_FILE is set in the environment or .env",
      ],
      [
        "a compose.yaml",
        () => writeFileSync(join(appDir, "compose.yaml"), "services: {}\n"),
        {},
        "ERROR: compose.yaml is next to docker-compose.yml",
      ],
    ] as const)(
      "refuses %s, which a plain docker compose would read",
      (_name, prepare, extra, message) => {
        prepare();
        const run = deploy(extra);

        expect(run.status).toBe(1);
        expect(lastLine(run)).toContain(message);
        expect(run.calls).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("private output", () => {
    it(
      "makes deploy-logs private, an older directory and its files included",
      () => {
        const dir = join(appDir, "deploy-logs");
        mkdirSync(dir, { mode: 0o755 });
        chmodSync(dir, 0o755);
        const old = join(dir, "20200101T000000Z-1.log");
        writeFileSync(old, "old\n", { mode: 0o644 });
        chmodSync(old, 0o644);
        const run = deploy({ STUB_MIGRATE: "fail" }, { umask: "022" });

        expect(run.status).toBe(1);
        expect(mode(dir)).toBe(0o700);
        const files = filesUnder(dir);
        // The old file, this run's log and the kept migration output at least.
        expect(files.length).toBeGreaterThanOrEqual(3);
        for (const file of files) expect([file, mode(file)]).toEqual([file, 0o600]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "stops before any output is redirected when env has no --ignore-signal",
      () => {
        writeFileSync(
          join(binDir, "env"),
          [
            "#!/bin/bash",
            'for a; do [[ $a != --ignore-signal* ]] || { echo "env: unrecognized option $a" >&2; exit 125; }; done',
            'exec /usr/bin/env "$@"',
            "",
          ].join("\n"),
        );
        chmodSync(join(binDir, "env"), 0o755);
        const run = deploy();

        expect(run.status).toBe(1);
        expect(lastLine(run)).toBe(
          "ERROR: GNU coreutils 8.31 or later is required (env --ignore-signal). Nothing changed.",
        );
        expect(run.calls).toEqual([]);
        expect(existsSync(join(appDir, "deploy-logs"))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );
  });

  it(
    "prints the report after a Ctrl-C that reaches the whole process group",
    async () => {
      const child = spawn("bash", [join(appDir, "deploy-app.sh")], {
        env: scriptEnv({ STUB_NEW_HEALTH: "starting:running:0", ETG_DEPLOY_HEALTH_TIMEOUT: "20" }),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const pid = child.pid ?? 0;
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
        process.kill(-pid, "SIGINT");
        expect(await exit).toBe(130);
        expect(out).toContain("---- availability report");
        expect(out).toContain("interrupted by SIGINT during the replace stage");
        expect(runLog()).toContain("interrupted by SIGINT during the replace stage");
      } finally {
        if (child.exitCode === null) {
          process.kill(-pid, "SIGKILL");
          await exit;
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "says the migration outcome is unknown after a signal during the migration",
    async () => {
      const child = spawn("bash", [join(appDir, "deploy-app.sh")], {
        env: scriptEnv({ STUB_MIGRATE_SLEEP: "1", ETG_DEPLOY_MIGRATE_TIMEOUT: "10" }),
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
        while (!calls().some((call) => call.endsWith(MIGRATE_RUN))) {
          if (Date.now() > deadline) throw new Error(`the migration never started: ${out}`);
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
        }
        child.kill("SIGTERM");
        expect(await exit).toBe(143);
        expect(upCalls({ status: null, signal: null, out, stdout: out, calls: calls() })).toEqual(
          [],
        );
        expect(out).toContain("migration: interrupted; outcome unknown");
        expect(calls()).toContain("IMAGE_TAG=v1.1.0 docker rm -f etg-migrate");
        expect(out).toContain(
          "interrupted by SIGTERM during the migration: nothing was replaced; no migrate container is left; the migration outcome is unknown (it may have committed).",
        );
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await exit;
        }
      }
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
