// Import this first from sentry instrument!
import '@utils/instrumentSentry';

import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import { redisClient } from '@cache/rediscache.client';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { instanceStateGauge, metricsEnabled, registry as metricsRegistry } from '@utils/metrics';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { join } from 'path';

async function initWA() {
  await waMonitor.loadInstance();
}

const errorWebhookClient = axios.create({ timeout: 5_000 });

// Register a minimal bootstrap-time SIGINT/SIGTERM handler BEFORE any async
// init runs, so Ctrl+C works even if startup hangs on a slow Prisma connect.
// The full graceful-shutdown handler replaces these later in bootstrap().
const bootstrapSignalHandlers = {
  sigterm: () => {
    console.log('[SERVER] SIGTERM during bootstrap — exiting');
    process.exit(143);
  },
  sigint: () => {
    console.log('[SERVER] SIGINT during bootstrap — exiting');
    process.exit(130);
  },
};
process.on('SIGTERM', bootstrapSignalHandlers.sigterm);
process.on('SIGINT', bootstrapSignalHandlers.sigint);

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    try {
      await providerFiles.onModuleInit();
    } catch (err) {
      logger.error(`Failed to init provider files: ${(err as Error)?.message ?? err}`);
      throw err;
    }
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  try {
    await prismaRepository.onModuleInit();
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.error(`Cannot connect to database: ${msg}`);
    logger.error('Verify DATABASE_CONNECTION_URI and that the database is reachable.');
    throw err;
  }

  // Trust N proxy hops so req.ip reflects the real client behind a load
  // balancer. 1 is the right value when exactly one reverse proxy (nginx,
  // ALB, Cloud Run, Cloudflare's final hop) sits in front.
  //
  // WARNING: if TRUST_PROXY_HOPS > 0 and the service is NOT actually behind
  // a proxy, clients can spoof their IP via X-Forwarded-For and bypass the
  // rate limiter. Set TRUST_PROXY_HOPS=0 for bare-metal / on-prem where
  // there is no proxy in front.
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
    logger.info(
      `trust proxy = ${trustProxyHops} — set TRUST_PROXY_HOPS=0 if this service is NOT behind a reverse proxy (prevents X-Forwarded-For spoofing).`,
    );
  } else {
    app.set('trust proxy', false);
    logger.info('trust proxy = false — req.ip will use the direct socket peer');
  }

  // /health must be reachable without auth so K8s/LB probes don't get blocked
  // by rate limiting or apikey middleware. Keep it cheap — a DB ping gates
  // readiness, a simple ack gates liveness.
  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await prismaRepository.$queryRaw`SELECT 1`;
      res.status(200).json({ status: 'ready' });
    } catch (e) {
      res.status(503).json({ status: 'unavailable', error: (e as Error)?.message });
    }
  });

  // Prometheus scrape endpoint. Unauthenticated and skipped by rate limiter
  // — put it behind a network policy / firewall instead of ACL here so the
  // scraper can poll cheaply.
  if (metricsEnabled) {
    app.get('/metrics', async (_req, res) => {
      try {
        // Refresh instance-state gauge on each scrape so the numbers always
        // reflect the current in-memory waInstances map.
        const byState: Record<string, number> = {};
        for (const inst of Object.values(waMonitor.waInstances ?? {})) {
          const state = (inst as any)?.stateConnection?.state ?? 'unknown';
          byState[state] = (byState[state] ?? 0) + 1;
        }
        instanceStateGauge.reset();
        for (const [state, count] of Object.entries(byState)) {
          instanceStateGauge.labels(state).set(count);
        }
        res.set('Content-Type', metricsRegistry.contentType);
        res.end(await metricsRegistry.metrics());
      } catch (e) {
        res.status(500).end(String((e as Error)?.message ?? e));
      }
    });
  }

  app.use(
    helmet({
      // Contact is a JSON API; CSP has no meaningful target. Keep it off to
      // avoid unexpected interference with served static assets (/public).
      contentSecurityPolicy: false,
      // Evolution API is frequently fronted by gateways with their own HSTS
      // policy; don't force one here.
      hsts: false,
    }),
  );

  // Rate limit — keep generous to avoid breaking legitimate bursty WA traffic,
  // but deflect naive DoS. Operators can override via env.
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 600);
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  if (rateLimitMax > 0) {
    app.use(
      rateLimit({
        windowMs: rateLimitWindowMs,
        max: rateLimitMax,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        // Never rate-limit health probes or Prometheus scrapes
        skip: (req) => req.path.startsWith('/health') || req.path === '/metrics',
      }),
    );
  }

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    // Body size limit: default 50mb is generous enough for base64-encoded
    // WhatsApp media sends (WA's own upload cap is 16mb; base64 overhead
    // ≈ ×1.33 → ~22mb payload) with headroom for legit clients, while
    // blocking the previous 136mb that let a single request OOM the process.
    // Tunable via REQUEST_BODY_LIMIT_MB.
    urlencoded({ extended: true, limit: `${process.env.REQUEST_BODY_LIMIT_MB ?? 50}mb` }),
    json({ limit: `${process.env.REQUEST_BODY_LIMIT_MB ?? 50}mb` }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000; //offset in milliseconds
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          errorWebhookClient
            .post(webhook.EVENTS.ERRORS_WEBHOOK, errorData)
            .catch((hookErr) => logger.error(`Error webhook delivery failed: ${hookErr?.message}`));
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  server.maxConnections = 10_000;

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  onUnexpectedError();

  // Replace the bootstrap-time signal handlers with the full graceful
  // shutdown that closes sockets, Prisma, Redis, etc.
  process.off('SIGTERM', bootstrapSignalHandlers.sigterm);
  process.off('SIGINT', bootstrapSignalHandlers.sigint);
  registerShutdownHandlers({ server, prismaRepository, logger });
}

interface ShutdownContext {
  server: { close: (cb?: (err?: Error) => void) => void };
  prismaRepository: PrismaRepository;
  logger: Logger;
}

// 30s is the default K8s terminationGracePeriodSeconds — be slightly under it.
const SHUTDOWN_TIMEOUT_MS = 25_000;

function registerShutdownHandlers({ server, prismaRepository, logger }: ShutdownContext) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} during shutdown; forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.warn(`Received ${signal}, starting graceful shutdown (max ${SHUTDOWN_TIMEOUT_MS}ms)...`);

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit.');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      waMonitor.stopZombieDetector?.();

      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('HTTP server closed.');

      await Promise.allSettled(
        Object.entries(waMonitor.waInstances ?? {}).map(async ([name, inst]) => {
          try {
            inst?.client?.ws?.close?.();
            await inst?.client?.end?.(undefined);
          } catch (e) {
            logger.error(`Failed to close instance "${name}": ${(e as Error)?.message ?? e}`);
          }
        }),
      );
      logger.info('Baileys instances closed.');

      await prismaRepository.onModuleDestroy();
      await redisClient.disconnect();
      await postgresClient.disconnect();
      logger.info('Shutdown complete.');
      process.exit(0);
    } catch (e) {
      logger.error(`Shutdown error: ${(e as Error)?.message ?? e}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  // Bootstrap threw after exhausting our nested try/catches. Log a clear
  // one-liner so operators see the reason without scrolling through a
  // Prisma query-engine dump, then exit with non-zero so the process
  // manager restarts us.
  const msg = (err as Error)?.message ?? String(err);
  // eslint-disable-next-line no-console
  console.error(`[SERVER] Bootstrap failed: ${msg}`);
  process.exit(1);
});
