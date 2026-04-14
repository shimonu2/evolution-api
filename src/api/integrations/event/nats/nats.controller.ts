import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { configService, Log, Nats } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { connect, NatsConnection, StringCodec } from 'nats';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

export class NatsController extends EventController implements EventControllerInterface {
  public natsClient: NatsConnection | null = null;
  private readonly logger = new Logger('NatsController');
  private readonly sc = StringCodec();

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Nats>('NATS')?.ENABLED, 'nats');
  }

  public async init(): Promise<void> {
    if (!this.status) {
      return;
    }

    try {
      const uri = configService.get<Nats>('NATS').URI;

      // Reconnect forever with a 2s backoff — NATS outages should be transient
      // and publish() calls made during disconnect are buffered client-side.
      this.natsClient = await connect({
        servers: uri,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2_000,
        pingInterval: 30_000,
      });

      this.logger.info('NATS initialized');

      // Observe disconnect / reconnect events so operators see them.
      (async () => {
        for await (const status of this.natsClient.status()) {
          if (status.type === 'disconnect' || status.type === 'reconnect' || status.type === 'error') {
            this.logger.warn(`NATS status: ${status.type} ${String((status as any).data ?? '')}`);
          }
        }
      })().catch((err) => this.logger.error(`NATS status stream error: ${(err as Error)?.message ?? err}`));

      // Surface permanent connection close.
      this.natsClient
        .closed()
        .then((err) => {
          if (err) this.logger.error(`NATS connection closed with error: ${err?.message ?? err}`);
          else this.logger.warn('NATS connection closed');
        })
        .catch((err) => this.logger.error(`NATS closed() rejected: ${(err as Error)?.message ?? err}`));

      if (configService.get<Nats>('NATS')?.GLOBAL_ENABLED) {
        await this.initGlobalSubscriptions();
      }
    } catch (error) {
      this.logger.error('Failed to connect to NATS:');
      this.logger.error(error);
      throw error;
    }
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('nats')) {
      return;
    }

    if (!this.status || !this.natsClient) {
      return;
    }

    // Don't attempt publish if the client has gone away; publish() would throw
    // and the buffering semantics we rely on during reconnect only apply while
    // the connection is merely disconnected, not closed.
    if (this.natsClient.isClosed()) {
      this.logger.warn(`Skipping NATS publish for event ${event}: client is closed`);
      return;
    }

    const instanceNats = await this.get(instanceName);
    const natsLocal = instanceNats?.events;
    const natsGlobal = configService.get<Nats>('NATS').GLOBAL_ENABLED;
    const natsEvents = configService.get<Nats>('NATS').EVENTS;
    const prefixKey = configService.get<Nats>('NATS').PREFIX_KEY;
    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');

    const message = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      server_url: serverUrl,
      date_time: dateTime,
      sender,
      apikey: apiKey,
    };

    // Instância específica
    if (instanceNats?.enabled) {
      if (Array.isArray(natsLocal) && natsLocal.includes(we)) {
        const subject = `${instanceName}.${event.toLowerCase()}`;

        try {
          this.natsClient.publish(subject, this.sc.encode(JSON.stringify(message)));

          if (logEnabled) {
            const logData = {
              local: `${origin}.sendData-NATS`,
              ...message,
            };
            this.logger.log(logData);
          }
        } catch (error) {
          this.logger.error(`Failed to publish to NATS (instance): ${error}`);
        }
      }
    }

    // Global
    if (natsGlobal && natsEvents[we]) {
      try {
        const subject = prefixKey ? `${prefixKey}.${event.toLowerCase()}` : event.toLowerCase();

        this.natsClient.publish(subject, this.sc.encode(JSON.stringify(message)));

        if (logEnabled) {
          const logData = {
            local: `${origin}.sendData-NATS-Global`,
            ...message,
          };
          this.logger.log(logData);
        }
      } catch (error) {
        this.logger.error(`Failed to publish to NATS (global): ${error}`);
      }
    }
  }

  private async initGlobalSubscriptions(): Promise<void> {
    this.logger.info('Initializing global subscriptions');

    const events = configService.get<Nats>('NATS').EVENTS;
    const prefixKey = configService.get<Nats>('NATS').PREFIX_KEY;

    if (!events) {
      this.logger.warn('No events to initialize on NATS');
      return;
    }

    const eventKeys = Object.keys(events);

    for (const event of eventKeys) {
      if (events[event] === false) continue;

      const subject = prefixKey ? `${prefixKey}.${event.toLowerCase()}` : event.toLowerCase();

      // Criar uma subscription para cada evento
      try {
        const subscription = this.natsClient.subscribe(subject);
        this.logger.info(`Subscribed to: ${subject}`);

        // Processar mensagens (exemplo básico)
        (async () => {
          for await (const msg of subscription) {
            try {
              const data = JSON.parse(this.sc.decode(msg.data));
              // Aqui você pode adicionar a lógica de processamento
              this.logger.debug(`Received message on ${subject}:`);
              this.logger.debug(data);
            } catch (error) {
              this.logger.error(`Error processing message on ${subject}:`);
              this.logger.error(error);
            }
          }
        })();
      } catch (error) {
        this.logger.error(`Failed to subscribe to ${subject}:`);
        this.logger.error(error);
      }
    }
  }
}
