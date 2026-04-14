import { Logger } from '@config/logger.config';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

// Prometheus registry + core metrics for Evolution API.
//
// Exposed at GET /metrics (set up in main.ts). Disable with METRICS=false.
// The default collector captures process/Node internals (CPU, memory, GC
// pauses, event-loop lag) which is often enough to detect leaks and stalls.
// Custom metrics are incremented by callers elsewhere in the code.

const logger = new Logger('Metrics');

export const metricsEnabled = process.env.METRICS !== 'false';

export const registry = new Registry();

if (metricsEnabled) {
  collectDefaultMetrics({ register: registry });
  logger.info('Metrics - ON (GET /metrics)');
}

// ----- Custom metrics -----

export const instanceStateGauge = new Gauge({
  name: 'evolution_instances_by_state',
  help: 'Number of WhatsApp instances currently in each connection state',
  labelNames: ['state'] as const,
  registers: [registry],
});

export const messagesSentCounter = new Counter({
  name: 'evolution_messages_sent_total',
  help: 'Count of outbound WhatsApp messages by result',
  labelNames: ['result'] as const, // success | retry | error
  registers: [registry],
});

export const chatbotCallsCounter = new Counter({
  name: 'evolution_chatbot_calls_total',
  help: 'Count of outbound chatbot HTTP calls by integration and result',
  labelNames: ['integration', 'result'] as const,
  registers: [registry],
});

export const reconnectsCounter = new Counter({
  name: 'evolution_reconnects_total',
  help: 'Count of Baileys reconnect events',
  registers: [registry],
});
