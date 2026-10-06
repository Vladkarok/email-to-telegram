import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createLogger,
  stderrLoggerDestination,
  getLogger,
  setLogger,
  sanitizeErrorForLog,
} from "../../../src/utils/logger.js";
import { DrizzleQueryError } from "drizzle-orm";
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

  describe("redaction", () => {
    function captureLog(write: (logger: ReturnType<typeof createLogger>) => void): string {
      const chunks: string[] = [];
      const dest = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(String(chunk));
          cb();
        },
      }) as never;
      write(createLogger("info", dest));
      return chunks.join("");
    }

    it("censors the payload a GrammyError carries, keeping the error context", () => {
      // pino's standard error serializer emits an Error's own enumerable
      // properties, so a failed sendMessage would otherwise log the whole
      // rendered email as err.payload.text.
      class GrammyError extends Error {
        method = "sendMessage";
        payload = { chat_id: 123, text: "confidential invoice body" };
        error_code = 502;
        description = "Bad Gateway";
        constructor() {
          super("Call to 'sendMessage' failed! (502: Bad Gateway)");
          this.name = "GrammyError";
        }
      }

      const output = captureLog((logger) => {
        logger.error({ err: new GrammyError() }, "send failed");
      });

      expect(output).not.toContain("confidential invoice body");
      expect(output).toContain("[redacted]");
      // Operational context must survive — it is what makes the line useful.
      expect(output).toContain("GrammyError");
      expect(output).toContain("502");
      expect(output).toContain("Bad Gateway");
    });

    it("censors a logged Telegram update object", () => {
      const output = captureLog((logger) => {
        logger.error(
          { err: new Error("bot failed"), update: { message: { text: "private message" } } },
          "Bot error",
        );
      });

      expect(output).not.toContain("private message");
      expect(output).toContain("[redacted]");
    });

    it("censors attachment filenames", () => {
      const output = captureLog((logger) => {
        logger.error(
          { err: new Error("disk full"), filename: "payslip-march.pdf" },
          "store failed",
        );
      });

      expect(output).not.toContain("payslip-march.pdf");
      expect(output).toContain("[redacted]");
    });

    it("drops SQL parameters and pg row details from query errors", () => {
      const pgError = Object.assign(
        new Error('duplicate key value violates unique constraint "idx_alias_full_address"'),
        {
          code: "23505",
          constraint: "idx_alias_full_address",
          detail: "Key (lower(full_address))=(secret-alias@example.com) already exists.",
        },
      );
      const queryError = new DrizzleQueryError(
        'insert into "delivery_logs" ("subject", "header_from") values ($1, $2)',
        ["March payslip for Jane", "boss@corp.example"],
        pgError,
      );

      const output = captureLog((logger) => {
        logger.error({ err: new Error("store failed", { cause: queryError }) }, "x");
        logger.error({ err: queryError }, "y");
      });

      for (const secret of ["March payslip", "boss@corp.example", "secret-alias@example.com"]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain('Failed query: insert into \\"delivery_logs\\"');
      expect(output).toContain("idx_alias_full_address");
      // The thrown error is untouched for code that still holds it.
      expect(queryError.message).toContain("March payslip");
      expect(pgError.detail).toContain("secret-alias@example.com");
    });

    it("logs ordinary errors unchanged", () => {
      const err = new Error("disk full");
      expect(sanitizeErrorForLog(err)).toBe(err);
    });

    it("keeps identifiers the privacy policy discloses", () => {
      const output = captureLog((logger) => {
        logger.info({ userId: 42, ip: "203.0.113.7" }, "request");
      });

      expect(output).toContain("42");
      expect(output).toContain("203.0.113.7");
    });
  });
});
