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
 * SQLSTATEs whose server message names only objects (constraint, column,
 * table), never row values. Any other pg error message, e.g. 22P02
 * `invalid input syntax for type uuid: "<value>"`, is replaced.
 */
const PG_CODES_WITH_SAFE_MESSAGES = new Set([
  "23505", // unique_violation (values are in `detail`)
  "23503", // foreign_key_violation
  "23502", // not_null_violation
  "23514", // check_violation
  "23P01", // exclusion_violation
  "22001", // string_data_right_truncation
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "53300", // too_many_connections
  "42P01", // undefined_table
  "42703", // undefined_column
]);

/** pg error fields that can carry row values or statement text. */
const PG_VALUE_FIELDS = ["detail", "where", "internalQuery"];

function isPgError(fields: Record<string, unknown>): boolean {
  return (
    typeof fields["code"] === "string" &&
    /^[0-9A-Z]{5}$/.test(fields["code"]) &&
    typeof fields["severity"] === "string"
  );
}

function withMessage(err: Error, copy: Error, message: string): void {
  copy.message = message;
  // Rebuild from the frames: the stack's header repeats the full message.
  const frames = (err.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  copy.stack = [`${err.name}: ${message}`, ...frames].join("\n");
}

/**
 * Query errors carry user content. Drizzle's `DrizzleQueryError` puts every
 * SQL parameter in its message, its stack and `params`, so a failed insert
 * into `delivery_logs` would log the subject and From address. pg errors put
 * row values in `detail` ("Key (...)=(...) already exists"), and some put the
 * offending value in the message itself. Returns a copy that keeps the SQL
 * text, SQLSTATE and object names and drops the values, through the `cause`
 * chain. The thrown error itself is never modified.
 */
export function sanitizeErrorForLog(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error) || depth > MAX_CAUSE_DEPTH) return err;
  const fields = err as Error & Record<string, unknown>;
  const isQueryError = typeof fields["query"] === "string" && "params" in fields;
  const isPg = isPgError(fields);
  const valueFields = PG_VALUE_FIELDS.filter((key) => fields[key] !== undefined);
  const cause = fields.cause;
  const safeCause = sanitizeErrorForLog(cause, depth + 1);
  if (!isQueryError && !isPg && valueFields.length === 0 && safeCause === cause) return err;

  const copy = Object.create(Object.getPrototypeOf(err) as object) as Error &
    Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(err)) copy[key] = fields[key];
  if (isQueryError) {
    withMessage(err, copy, `Failed query: ${String(fields["query"])}`);
    copy["params"] = CENSOR;
  } else if (isPg && !PG_CODES_WITH_SAFE_MESSAGES.has(String(fields["code"]))) {
    const names = ["constraint", "table", "column"]
      .filter((key) => typeof fields[key] === "string")
      .map((key) => `${key} ${String(fields[key])}`);
    withMessage(err, copy, [`pg error ${String(fields["code"])}`, ...names].join(", "));
  }
  for (const key of valueFields) copy[key] = CENSOR;
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
