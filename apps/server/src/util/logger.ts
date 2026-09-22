import pino, { type Logger } from 'pino';

let rootLogger: Logger | null = null;

export function initLogger(level: string, pretty: boolean): Logger {
  rootLogger = pino({
    level,
    base: { app: 'autogit' },
    transport: pretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname,app',
          },
        }
      : undefined,
  });
  return rootLogger;
}

export function logger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({ level: 'info', base: { app: 'autogit' } });
  }
  return rootLogger;
}

export function childLogger(scope: string): Logger {
  return logger().child({ scope });
}
