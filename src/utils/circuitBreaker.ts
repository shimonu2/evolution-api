import { Logger } from '@config/logger.config';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import CircuitBreaker from 'opossum';

// Per-endpoint circuit breakers for chatbot HTTP calls. After N consecutive
// failures the breaker opens and fails fast instead of letting every new
// message stack behind a dead upstream. Half-open probe after the reset
// timeout lets it recover automatically.
//
// Disable entirely via CIRCUIT_BREAKER=false (development / debugging).

const logger = new Logger('CircuitBreaker');

const ENABLED = process.env.CIRCUIT_BREAKER !== 'false';
const TIMEOUT_MS = Number(process.env.CIRCUIT_BREAKER_TIMEOUT_MS ?? 30_000);
const ERROR_THRESHOLD_PERCENTAGE = Number(process.env.CIRCUIT_BREAKER_ERROR_PCT ?? 50);
const RESET_TIMEOUT_MS = Number(process.env.CIRCUIT_BREAKER_RESET_MS ?? 30_000);
const VOLUME_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_VOLUME ?? 5);

type PostFn = (url: string, data: unknown, config?: AxiosRequestConfig) => Promise<AxiosResponse>;

const breakers = new Map<string, CircuitBreaker<Parameters<PostFn>, AxiosResponse>>();

function keyFor(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function getBreaker(key: string): CircuitBreaker<Parameters<PostFn>, AxiosResponse> {
  let breaker = breakers.get(key);
  if (breaker) return breaker;

  breaker = new CircuitBreaker<Parameters<PostFn>, AxiosResponse>(
    (url, data, config) => axios.post(url, data, config),
    {
      timeout: TIMEOUT_MS,
      errorThresholdPercentage: ERROR_THRESHOLD_PERCENTAGE,
      resetTimeout: RESET_TIMEOUT_MS,
      volumeThreshold: VOLUME_THRESHOLD,
      name: key,
      // 4xx responses are client errors, not endpoint health problems —
      // don't trip the breaker on them.
      errorFilter: (err) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        return typeof status === 'number' && status >= 400 && status < 500;
      },
    },
  );

  breaker.on('open', () => logger.warn(`circuit OPEN: ${key}`));
  breaker.on('halfOpen', () => logger.info(`circuit HALF-OPEN (probing): ${key}`));
  breaker.on('close', () => logger.info(`circuit CLOSE (recovered): ${key}`));

  breakers.set(key, breaker);
  return breaker;
}

export async function circuitPost(url: string, data: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse> {
  if (!ENABLED) {
    return axios.post(url, data, config);
  }
  const breaker = getBreaker(keyFor(url));
  return breaker.fire(url, data, config);
}
