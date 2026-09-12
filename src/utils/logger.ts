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

export function createLogger(
  level: string = "info",
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
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
