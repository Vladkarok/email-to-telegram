import pino from "pino";

let _logger: pino.Logger | null = null;

export function createLogger(level: string = "info"): pino.Logger {
  return pino({
    level,
    transport:
      process.env["NODE_ENV"] !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
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
