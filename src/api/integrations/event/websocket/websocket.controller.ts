import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Auth, configService, Cors, Log, Websocket } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Server } from 'http';
import { Server as SocketIO } from 'socket.io';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';

// Global + per-IP WebSocket connection caps.
// Without them, a single IP can open N thousand Socket.io connections,
// each holding ~100 KB of buffers + a background ping timer, and starve
// every other client. Defaults are generous for normal usage but stop
// pathological cases. Set _MAX=0 to disable a specific cap.
const WS_MAX_TOTAL = Number(process.env.WEBSOCKET_MAX_CONNECTIONS ?? 5_000);
const WS_MAX_PER_IP = Number(process.env.WEBSOCKET_MAX_CONNECTIONS_PER_IP ?? 50);

export class WebsocketController extends EventController implements EventControllerInterface {
  private io: SocketIO;
  private corsConfig: Array<any>;
  private readonly logger = new Logger('WebsocketController');
  private connectionsByIp = new Map<string, number>();
  private totalConnections = 0;

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Websocket>('WEBSOCKET')?.ENABLED, 'websocket');

    this.cors = configService.get<Cors>('CORS').ORIGIN;
  }

  public init(httpServer: Server): void {
    if (!this.status) {
      return;
    }

    this.socket = new SocketIO(httpServer, {
      cors: { origin: this.cors },
      allowRequest: async (req, callback) => {
        try {
          const remoteAddress = req.socket.remoteAddress ?? 'unknown';

          // Connection-count gate. Run this before auth so auth work isn't
          // wasted on a connection we'd reject anyway.
          if (WS_MAX_TOTAL > 0 && this.totalConnections >= WS_MAX_TOTAL) {
            this.logger.warn(`WS rejected: total cap reached (${WS_MAX_TOTAL})`);
            return callback('Too many connections (global)', false);
          }
          if (WS_MAX_PER_IP > 0 && (this.connectionsByIp.get(remoteAddress) ?? 0) >= WS_MAX_PER_IP) {
            this.logger.warn(`WS rejected: per-IP cap reached for ${remoteAddress} (${WS_MAX_PER_IP})`);
            return callback('Too many connections (per-IP)', false);
          }

          const url = new URL(req.url || '', 'http://localhost');
          const params = new URLSearchParams(url.search);

          const websocketConfig = configService.get<Websocket>('WEBSOCKET');
          const allowedHosts = websocketConfig.ALLOWED_HOSTS || '127.0.0.1,::1,::ffff:127.0.0.1';
          const allowAllHosts = allowedHosts.trim() === '*';
          const isAllowedHost =
            allowAllHosts ||
            allowedHosts
              .split(',')
              .map((h) => h.trim())
              .includes(remoteAddress);

          if (params.has('EIO') && isAllowedHost) {
            return callback(null, true);
          }

          const apiKey = params.get('apikey') || (req.headers.apikey as string);

          if (!apiKey) {
            this.logger.error('Connection rejected: apiKey not provided');
            return callback('apiKey is required', false);
          }

          const instance = await this.prismaRepository.instance.findFirst({ where: { token: apiKey } });

          if (!instance) {
            const globalToken = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
            if (apiKey !== globalToken) {
              this.logger.error('Connection rejected: invalid global token');
              return callback('Invalid global token', false);
            }
          }

          callback(null, true);
        } catch (error) {
          this.logger.error('Authentication error:');
          this.logger.error(error);
          callback('Authentication error', false);
        }
      },
    });

    this.socket.on('connection', (socket) => {
      const remoteAddress = socket.handshake.address ?? 'unknown';
      this.totalConnections++;
      this.connectionsByIp.set(remoteAddress, (this.connectionsByIp.get(remoteAddress) ?? 0) + 1);
      this.logger.info(
        `User connected (total=${this.totalConnections}, ip=${remoteAddress}, ip_count=${this.connectionsByIp.get(remoteAddress)})`,
      );

      socket.on('disconnect', () => {
        this.totalConnections = Math.max(0, this.totalConnections - 1);
        const current = (this.connectionsByIp.get(remoteAddress) ?? 1) - 1;
        if (current <= 0) {
          this.connectionsByIp.delete(remoteAddress);
        } else {
          this.connectionsByIp.set(remoteAddress, current);
        }
        this.logger.info('User disconnected');
      });

      socket.on('sendNode', async (data) => {
        try {
          await this.waMonitor.waInstances[data.instanceId].baileysSendNode(data.stanza);
          this.logger.info('Node sent successfully');
        } catch (error) {
          this.logger.error('Error sending node:');
          this.logger.error(error);
        }
      });
    });

    this.logger.info(`Socket.io initialized (max total=${WS_MAX_TOTAL}, max per-IP=${WS_MAX_PER_IP})`);
  }

  private set cors(cors: Array<any>) {
    this.corsConfig = cors;
  }

  private get cors(): string | Array<any> {
    return this.corsConfig?.includes('*') ? '*' : this.corsConfig;
  }

  private set socket(socket: SocketIO) {
    this.io = socket;
  }

  public get socket(): SocketIO {
    return this.io;
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
    if (integration && !integration.includes('websocket')) {
      return;
    }

    if (!this.status) {
      return;
    }

    const configEv = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBSOCKET');
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

    if (configService.get<Websocket>('WEBSOCKET')?.GLOBAL_EVENTS) {
      this.socket.emit(event, message);

      if (logEnabled) {
        this.logger.log({ local: `${origin}.sendData-WebsocketGlobal`, ...message });
      }
    }

    try {
      const instance = await this.get(instanceName);

      if (!instance?.enabled) {
        return;
      }

      if (Array.isArray(instance?.events) && instance?.events.includes(configEv)) {
        this.socket.of(`/${instanceName}`).emit(event, message);

        if (logEnabled) {
          this.logger.log({ local: `${origin}.sendData-Websocket`, ...message });
        }
      }
    } catch (err) {
      if (logEnabled) {
        this.logger.log(err);
      }
    }
  }
}
