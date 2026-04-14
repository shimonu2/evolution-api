// Import this first from sentry instrument!
import '@utils/instrumentSentry';

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

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  // Trust the first proxy hop so req.ip reflects the real client when running
  // behind a load balancer (nginx, ALB, Cloud Run). Required for reliable
  // rate-limit keying and accurate logging.
  app.set('trust proxy', 1);

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
    urlencoded({ extended: true, limit: '5mb' }),
    json({ limit: '5mb' }),
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

bootstrap();
