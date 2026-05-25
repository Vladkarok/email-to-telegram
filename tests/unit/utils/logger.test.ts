import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createLogger,
  stderrLoggerDestination,
  getLogger,
  setLogger,
} from "../../../src/utils/logger.js";
import { Writable } from "stream";

describe("logger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createLogger returns a pino logger with the given level", () => {
    const logger = createLogger("warn");
    expect(logger.level).toBe("warn");
  });

  it("createLogger with a destination stream skips pino-pretty transport", () => {
    const dest = new Writable({ write: () => {} }) as never;
    const logger = createLogger("info", dest);
    expect(logger.level).toBe("info");
  });

  it("stderrLoggerDestination returns a writable destination", () => {
    const dest = stderrLoggerDestination();
    expect(dest).toBeDefined();
  });

  it("getLogger returns a logger, reusing the cached instance", () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });

  it("setLogger replaces the cached logger", () => {
    const custom = createLogger("error");
    setLogger(custom);
    expect(getLogger()).toBe(custom);
  });

  it("getLogger uses LOG_LEVEL env when no logger is cached", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    setLogger(null as never);
    const logger = getLogger();
    expect(logger.level).toBe("debug");
  });
});
