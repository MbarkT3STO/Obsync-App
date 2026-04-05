type LogLevel = 'info' | 'warn' | 'error' | 'debug';

// ── Production log suppression ─────────────────────────────────────────────
// In production builds, suppress info/debug logs entirely to avoid
// unnecessary string allocations and console I/O on every sync event.
const IS_DEV = process.env['NODE_ENV'] !== 'production';

// Simple rate-limiter: track last log time per (prefix+message) key
const rateLimitMap = new Map<string, number>();
const RATE_LIMIT_MS = 5000; // same message from same logger suppressed for 5s

class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    // In production, only emit warnings and errors
    if (!IS_DEV && (level === 'info' || level === 'debug')) return;

    // Rate-limit repeated identical messages (common during polling)
    const key = `${this.prefix}:${level}:${message}`;
    const now = Date.now();
    const last = rateLimitMap.get(key) ?? 0;
    if (now - last < RATE_LIMIT_MS) return;
    rateLimitMap.set(key, now);

    // Prune rate-limit map to avoid unbounded growth
    if (rateLimitMap.size > 500) {
      const cutoff = now - RATE_LIMIT_MS * 2;
      for (const [k, t] of rateLimitMap) {
        if (t < cutoff) rateLimitMap.delete(k);
      }
    }

    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] [${level.toUpperCase()}] [${this.prefix}] ${message}`;
    if (level === 'error') {
      console.error(formatted, ...args);
    } else if (level === 'warn') {
      console.warn(formatted, ...args);
    } else {
      console.log(formatted, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void { this.log('info', message, ...args); }
  warn(message: string, ...args: unknown[]): void { this.log('warn', message, ...args); }
  error(message: string, ...args: unknown[]): void { this.log('error', message, ...args); }
  debug(message: string, ...args: unknown[]): void { this.log('debug', message, ...args); }
}

export function createLogger(prefix: string): Logger {
  return new Logger(prefix);
}
