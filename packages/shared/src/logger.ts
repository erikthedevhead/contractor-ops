import { pino } from 'pino';

/**
 * Structured logger. Redaction is defense in depth: code should never hand
 * tokens to the logger in the first place.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      '*.access_token', '*.refresh_token', '*.id_token', '*.accessToken', '*.refreshToken',
      '*.authorization', '*.Authorization', '*.client_secret', '*.password',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
