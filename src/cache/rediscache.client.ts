import { CacheConf, CacheConfRedis, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

class Redis {
  private logger = new Logger('Redis');
  private client: RedisClientType = null;
  private conf: CacheConfRedis;
  private connected = false;
  // Dedup reconnect / error spam: without a filter, a down Redis produces
  // ~10 lines/sec at peak backoff rate and drowns real signal in logs.
  private lastErrorMessage = '';
  private lastErrorLoggedAt = 0;

  constructor() {
    this.conf = configService.get<CacheConf>('CACHE')?.REDIS;
  }

  // Log attempts 1, 5, 10, 15, 20 only — enough to see progress without
  // flooding. Always log the first (so operators know) and the last (so
  // they know we gave up).
  private shouldLogRetry(retries: number): boolean {
    return retries <= 1 || retries === 20 || retries % 5 === 0;
  }

  // Suppress duplicate error messages within a 30s window so a persistent
  // "ECONNREFUSED" doesn't appear 300 times in 30s.
  private logErrorDeduped(msg: string) {
    const now = Date.now();
    if (msg === this.lastErrorMessage && now - this.lastErrorLoggedAt < 30_000) return;
    this.lastErrorMessage = msg;
    this.lastErrorLoggedAt = now;
    this.logger.error(`redis error: ${msg}`);
  }

  getConnection(): RedisClientType {
    if (this.connected && this.client) {
      return this.client;
    }

    this.client = createClient({
      url: this.conf.URI,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            this.logger.error('redis reconnect: giving up after 20 attempts');
            return new Error('Redis max reconnect attempts exceeded');
          }
          const delay = Math.min(retries * 100, 3_000);
          if (this.shouldLogRetry(retries)) {
            this.logger.warn(`redis reconnect attempt ${retries} in ${delay}ms`);
          }
          return delay;
        },
      },
    });

    this.client.on('connect', () => {
      this.logger.verbose('redis connecting');
    });

    this.client.on('ready', () => {
      this.logger.info('redis ready');
      this.connected = true;
      this.lastErrorMessage = '';
    });

    this.client.on('error', (err) => {
      this.logErrorDeduped(String(err?.message ?? err));
      this.connected = false;
    });

    this.client.on('end', () => {
      this.logger.verbose('redis connection ended');
      this.connected = false;
    });

    this.client.on('reconnecting', () => {
      // suppressed: reconnectStrategy() already logs these with context
    });

    this.client.connect().catch((e) => {
      this.logger.error(`redis initial connect failed: ${e?.message || e}`);
    });

    return this.client;
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.quit();
    } catch (e) {
      this.logger.error(`redis quit failed: ${(e as Error)?.message || e}`);
    } finally {
      this.connected = false;
      this.client = null;
    }
  }
}

export const redisClient = new Redis();
