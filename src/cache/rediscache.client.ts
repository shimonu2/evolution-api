import { CacheConf, CacheConfRedis, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { createClient, RedisClientType } from 'redis';

class Redis {
  private logger = new Logger('Redis');
  private client: RedisClientType = null;
  private conf: CacheConfRedis;
  private connected = false;

  constructor() {
    this.conf = configService.get<CacheConf>('CACHE')?.REDIS;
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
          this.logger.warn(`redis reconnect attempt ${retries} in ${delay}ms`);
          return delay;
        },
      },
    });

    this.client.on('connect', () => {
      this.logger.verbose('redis connecting');
    });

    this.client.on('ready', () => {
      this.logger.verbose('redis ready');
      this.connected = true;
    });

    this.client.on('error', (err) => {
      this.logger.error(`redis error: ${err?.message || err}`);
      this.connected = false;
    });

    this.client.on('end', () => {
      this.logger.verbose('redis connection ended');
      this.connected = false;
    });

    this.client.on('reconnecting', () => {
      this.logger.verbose('redis reconnecting');
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
