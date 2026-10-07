import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

/** The `app:` service block of a compose file, up to the next service. */
function appService(file: string): string {
  const text = readFileSync(join(ROOT, file), "utf8");
  const match = /\n {2}app:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|\n[a-z]|$)/.exec(text);
  if (!match) throw new Error(`no app service in ${file}`);
  return match[1];
}

describe.each(["docker-compose.yml", "docs/examples/docker-compose.standalone.yml"])(
  "%s app service",
  (file) => {
    it("runs behind Docker's init, so a stop signal during startup ends the app at once", () => {
      expect(appService(file)).toMatch(/^ {4}init: true$/m);
    });

    it("gives the 25-s shutdown deadline a 30-s grace period", () => {
      expect(appService(file)).toMatch(/^ {4}stop_grace_period: 30s$/m);
    });
  },
);
