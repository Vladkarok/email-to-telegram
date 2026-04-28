import pino from "pino";

let _logger: pino.Logger | null = null;

export function createLogger(
  level: string = "info",
  destination?: pino.DestinationStream,
): pino.Logger {
  const options: pino.LoggerOptions = {
    level,
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
