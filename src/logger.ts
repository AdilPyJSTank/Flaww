import pino from 'pino';
import { env } from './env';

export const log = pino({
  level: env.LOG_LEVEL,
  // Redact anything that could carry a credential into the log stream.
  redact: {
    paths: [
      'password',
      'access_token',
      'refresh_token',
      '*.password',
      '*.access_token',
      '*.refresh_token',
      'headers.authorization',
      '*.headers.authorization',
    ],
    censor: '[redacted]',
  },
  transport:
    process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
