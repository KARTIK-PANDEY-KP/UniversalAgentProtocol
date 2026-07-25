import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  level: LogLevel;
  time: string;
  message: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
}

export const consoleSink: LogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export const silentSink: LogSink = () => {};

class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.sink = options.sink ?? consoleSink;
    this.bindings = options.bindings ?? {};
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged = { ...this.bindings, ...(fields ?? {}) };
    const safe = redact(merged) as Record<string, unknown>;
    this.sink({
      ...safe,
      level,
      time: new Date().toISOString(),
      message: redact(message) as string,
    });
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}
