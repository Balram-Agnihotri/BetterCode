import pino from 'pino';

/**
 * Minimal logger surface used across BetterCode. Kept as an interface so unit
 * tests can pass a no-op logger without pulling in pino, and so we can swap
 * transports (CloudWatch JSON in Lambda) without touching call sites.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never serialize raw secrets; redact common token-bearing keys defensively.
  redact: {
    paths: [
      'token',
      'botToken',
      'signingSecret',
      'apiKey',
      'authorization',
      '*.token',
      '*.apiKey',
      'headers.authorization',
    ],
    censor: '«redacted»',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return base.child(bindings) as unknown as Logger;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
