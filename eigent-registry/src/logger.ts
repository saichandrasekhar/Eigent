/**
 * Structured JSON logger for the Eigent registry.
 *
 * Replaces ad-hoc console.log/console.error with a structured logger
 * that emits JSON lines with consistent fields: timestamp, level,
 * component, message, and arbitrary context.
 *
 * Log level is controlled via the LOG_LEVEL environment variable
 * (default: "info"). Accepted values: debug, info, warn, error.
 */

// ── Types ───────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  agent_id?: string;
  human_email?: string;
  tool?: string;
  latency_ms?: number;
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  [key: string]: unknown;
}

// ── Level ordering ──────────────────────────────────────────────────────

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function parseLogLevel(raw: string | undefined): LogLevel {
  const normalized = (raw ?? 'info').toLowerCase();
  if (normalized in LEVEL_PRIORITY) {
    return normalized as LogLevel;
  }
  return 'info';
}

// ── Logger class ────────────────────────────────────────────────────────

export class Logger {
  private readonly component: string;
  private readonly minLevel: LogLevel;

  constructor(component: string, level?: LogLevel) {
    this.component = component;
    this.minLevel = level ?? parseLogLevel(process.env.LOG_LEVEL);
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Create a child logger with a different component name,
   * inheriting the parent's log level.
   */
  child(component: string): Logger {
    return new Logger(component, this.minLevel);
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...context,
    };

    const line = JSON.stringify(entry);

    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

// ── Default logger instance ─────────────────────────────────────────────

export const logger = new Logger('registry');

export default logger;
