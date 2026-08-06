import * as Sentry from '@sentry/node';

import { Logger } from './logger.config';

// Exit on uncaught errors so the process manager (PM2, Docker, K8s) can restart
// us into a clean state. Continuing in an unknown state risks data corruption.
// Configurable via EXIT_ON_UNCAUGHT=false for development.
const shouldExit = process.env.EXIT_ON_UNCAUGHT !== 'false';

export function onUnexpectedError() {
  process.on('uncaughtException', (error, origin) => {
    const logger = new Logger('uncaughtException');
    logger.error({ origin, error });
    Sentry.captureException(error, { tags: { origin: String(origin) } });

    if (shouldExit) {
      // Give Sentry + logger a brief window to flush before exit
      setTimeout(() => process.exit(1), 1_000).unref();
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    const logger = new Logger('unhandledRejection');
    logger.error({ reason, promise });
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
    // Do NOT exit on unhandled rejection — they are often recoverable and
    // exiting can cause churn. Fix the root cause in application code.
  });
}
