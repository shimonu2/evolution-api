import { Chatwoot, configService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import postgresql from 'pg';

const { Pool } = postgresql;

class Postgres {
  private logger = new Logger('Postgres');
  private pool: postgresql.Pool | null = null;
  private connected = false;

  getConnection(connectionString: string): postgresql.Pool {
    if (this.connected && this.pool) {
      return this.pool;
    }

    // If we have a dead pool from a prior error, end it before creating a
    // new one — the .end() is best-effort (the pool may already be broken).
    if (this.pool) {
      this.pool.end().catch(() => {
        // swallow — the old pool is broken and we're replacing it
      });
      this.pool = null;
    }

    const pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      // Conservative limits; operators can tune via env.
      max: Number(process.env.CHATWOOT_PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      this.logger.error(`postgres pool error: ${err?.message ?? err}`);
      // Mark disconnected so the next getConnection() rebuilds the pool
      // rather than handing out broken clients.
      this.connected = false;
    });

    this.pool = pool;
    this.connected = true;
    return this.pool;
  }

  getChatwootConnection(): postgresql.Pool {
    const uri = configService.get<Chatwoot>('CHATWOOT').IMPORT.DATABASE.CONNECTION.URI;
    return this.getConnection(uri);
  }

  // Called by graceful-shutdown in main.ts so K8s/PM2 rolling restarts
  // don't leave dangling Postgres connections that eventually exhaust the
  // server's max_connections.
  async disconnect(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.end();
    } catch (e) {
      this.logger.warn(`postgres pool.end() failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.pool = null;
      this.connected = false;
    }
  }
}

export const postgresClient = new Postgres();
