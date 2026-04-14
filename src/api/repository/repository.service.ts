import { ConfigService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { PrismaClient } from '@prisma/client';

export class Query<T> {
  where?: T;
  sort?: 'asc' | 'desc';
  page?: number;
  offset?: number;
}

// Keep defaults conservative; operators can override via env.
const CONNECTION_LIMIT = Number(process.env.DATABASE_CONNECTION_LIMIT ?? 20);
const POOL_TIMEOUT_SEC = Number(process.env.DATABASE_POOL_TIMEOUT ?? 10);
const CONNECT_TIMEOUT_SEC = Number(process.env.DATABASE_CONNECT_TIMEOUT ?? 10);
const STATEMENT_TIMEOUT_MS = Number(process.env.DATABASE_STATEMENT_TIMEOUT ?? 15_000);

// Append pool/timeout params to the connection URI without clobbering existing
// query params. statement_timeout is only applied for Postgres; MySQL does not
// support it as a connection string parameter in Prisma.
function buildDatabaseUrl(rawUri: string, provider: string): string {
  if (!rawUri) return rawUri;
  try {
    const url = new URL(rawUri);
    const set = (key: string, value: string) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    };
    set('connection_limit', String(CONNECTION_LIMIT));
    set('pool_timeout', String(POOL_TIMEOUT_SEC));
    set('connect_timeout', String(CONNECT_TIMEOUT_SEC));
    if (provider === 'postgresql' && STATEMENT_TIMEOUT_MS > 0) {
      set('statement_timeout', String(STATEMENT_TIMEOUT_MS));
    }
    return url.toString();
  } catch {
    // Malformed URI — let Prisma report the problem with the original value
    return rawUri;
  }
}

export class PrismaRepository extends PrismaClient {
  constructor(private readonly configService: ConfigService) {
    const db = configService.get<Database>('DATABASE');
    const url = buildDatabaseUrl(db?.CONNECTION?.URI ?? '', db?.PROVIDER ?? 'postgresql');
    super({
      datasources: url ? { db: { url } } : undefined,
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    // Observability — surface Prisma's own warnings/errors through our logger
    (this as any).$on('warn', (e: { message: string }) => this.logger.warn(`prisma warn: ${e.message}`));
    (this as any).$on('error', (e: { message: string }) => this.logger.error(`prisma error: ${e.message}`));
  }

  private readonly logger = new Logger('PrismaRepository');

  public async onModuleInit() {
    await this.$connect();
    this.logger.info(
      `Repository:Prisma - ON (pool=${CONNECTION_LIMIT} connect=${CONNECT_TIMEOUT_SEC}s statement=${STATEMENT_TIMEOUT_MS}ms)`,
    );
  }

  public async onModuleDestroy() {
    await this.$disconnect();
    this.logger.warn('Repository:Prisma - OFF');
  }
}
