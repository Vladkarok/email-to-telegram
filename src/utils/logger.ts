import pino from "pino";

let _logger: pino.Logger | null = null;

/**
 * Log keys that carry user content rather than operational context.
 *
 * - `payload` — pino's standard error serializer emits an Error's own
 *   enumerable properties, and `GrammyError` carries the outgoing API payload.
 *   For a failed delivery that payload holds the whole rendered email.
 * - `update` — the raw Telegram update logged on bot errors: message text,
 *   names, usernames.
 * - `filename` — attachment names from inbound mail.
 *
 * Identifiers the privacy policy already discloses (`userId`, `ip`, error
 * type/code/description) are deliberately left readable; they are what makes
 * a log line useful during an incident.
 */
const REDACTED_PATHS = ["payload", "*.payload", "update", "*.update", "filename", "*.filename"];

const CENSOR = "[redacted]";

/** How deep a `cause` chain is followed before the rest is logged as is. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Query errors carry user content in their SQL parameters. Drizzle's
 * `DrizzleQueryError` puts them in its message, its stack and `params`, so a
 * failed insert into `delivery_logs` would log the subject and From address;
 * pg errors put row values in `detail` ("Key (...)=(...) already exists").
 * Returns a copy that keeps the SQL text, codes and constraint names and
 * drops the values. The thrown error itself is never modified.
 */
export function sanitizeErrorForLog(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error) || depth > MAX_CAUSE_DEPTH) return err;
  const fields = err as Error & Record<string, unknown>;
  const isQueryError = typeof fields["query"] === "string" && "params" in fields;
  const hasDetail = typeof fields["detail"] === "string";
  const cause = fields.cause;
  const safeCause = sanitizeErrorForLog(cause, depth + 1);
  if (!isQueryError && !hasDetail && safeCause === cause) return err;

  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error &
    Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(err)) copy[key] = fields[key];
  if (isQueryError) {
    const safeMessage = `Failed query: ${String(fields["query"])}`;
    copy.message = safeMessage;
    // Rebuild from the frames: the stack's header repeats the full message.
    const frames = (err.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
    copy.stack = [`${err.name}: ${safeMessage}`, ...frames].join("\n");
    copy["params"] = CENSOR;
  }
  if (hasDetail) copy["detail"] = CENSOR;
  if (cause !== undefined) copy.cause = safeCause;
  return copy;
}

export function createLogger(
  level: string = "info",
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACTED_PATHS, censor: CENSOR },
    serializers: {
      err: (err: unknown) => pino.stdSerializers.err(sanitizeErrorForLog(err) as Error),
    },
    transport:
      !destination && process.env["NODE_ENV"] !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  };
  return destination ? pino(options, destination) : pino(options);
}

export function stderrLoggerDestination(): pino.DestinationStream {
  return pino.destination(2);
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = createLogger(process.env["LOG_LEVEL"] ?? "info");
  }
  return _logger;
}

export function setLogger(logger: pino.Logger): void {
  _logger = logger;
}
