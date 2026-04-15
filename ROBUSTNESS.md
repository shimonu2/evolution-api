# Robustness operator guide (v2.3.8-robustness.0414.x)

This document covers the robustness hardening shipped in the `feat/robustness-0414`
branch. It is written for operators who run Evolution API in production, not for
developers reading the source.

---

## TL;DR

- 20+ new env vars, all optional, all with defaults that preserve prior behavior
  where it was safe and tighten it where the previous default was dangerous.
- Two behavior changes worth knowing before deploy:
  1. **Body size** default dropped from 136 MB to 50 MB.
  2. **Sends against a dead socket now fail fast** with 400, where they used
     to silently queue. Opt out per instance with `ENSURE_CONNECTED_ON_SEND=false`.
- New endpoints: `GET /health/live`, `GET /health/ready`, `GET /metrics`.
- Graceful shutdown on `SIGTERM` / `SIGINT` now closes HTTP, Baileys sockets,
  Prisma, Redis, and Chatwoot Postgres. 25 s timeout then hard exit.

---

## New environment variables

All are optional. All values are strings; the runtime parses to number /
boolean as appropriate.

### HTTP / bootstrap

| Variable | Default | Purpose |
|---|---|---|
| `REQUEST_BODY_LIMIT_MB` | `50` | JSON / urlencoded body cap. Previously 136 MB (too permissive for DoS), then briefly 5 MB (broke `/send/media` with base64 video). 50 MB fits the largest legitimate WA media send (16 MB × 1.33 base64 overhead ≈ 22 MB) with headroom. |
| `TRUST_PROXY_HOPS` | `1` | How many `X-Forwarded-For` hops to trust. Set to `0` if the service is NOT behind a reverse proxy — otherwise clients can spoof their IP and bypass the rate limiter. Value logged at startup. |
| `RATE_LIMIT_MAX` | `600` | Max requests per IP per window. Set to `0` to disable. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window length in ms. |
| `EXIT_ON_UNCAUGHT` | `true` | If `false`, `uncaughtException` is logged but the process keeps running. Default is to log + exit(1) so the process manager restarts into a clean state. Only set to `false` in dev. |

### Database (Prisma)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_CONNECTION_LIMIT` | `20` | Prisma pool size. Prior default was ~10. |
| `DATABASE_CONNECT_TIMEOUT` | `10` | Seconds before a pool acquire fails. |
| `DATABASE_POOL_TIMEOUT` | `10` | Seconds to wait when pool is saturated. |
| `DATABASE_STATEMENT_TIMEOUT` | `15000` | Postgres-only query timeout in ms. MySQL does not support this via connection string. Set `0` to disable. |
| `CHATWOOT_PG_POOL_MAX` | `10` | Chatwoot-specific Postgres pool max. |

### Redis

Redis has no new env vars — the reconnect strategy and connect timeout are
hard-coded. If Redis is down at startup, the client retries 20 times with
progressive backoff (100 ms → 3 s) then gives up. Log noise is throttled to
attempts 1, 5, 10, 15, 20.

### Baileys / WhatsApp

| Variable | Default | Purpose |
|---|---|---|
| `ENSURE_CONNECTED_ON_SEND` | `true` | If `true`, sends against a disconnected instance throw `BadRequestException` after a 5 s wait. If `false`, restores the pre-0414 silent-queue behavior (messages queued into Baileys against a dead WS). |
| `PAIRING_BUDGET_MS` | `300000` | Absolute wall-clock timeout for a QR pairing attempt (5 min). Separate from the count-based `QRCODE_LIMIT`. |
| `STATUS_BATCH_DELAY_MS` | `200` | Delay between status-broadcast batches. At 0 the 10-contact batches fire in parallel (WhatsApp ban risk). |
| `WA_MEDIA_MAX_BYTES` | `52428800` (50 MB) | Cap on media download size for both the WhatsApp Business media fetch and the Baileys `webhookBase64` inline. Oversized media is skipped and logged. |
| `INSTANCE_HEALTHCHECK` | `true` | Enable the zombie-instance detector. Set to `false` to disable. |
| `INSTANCE_HEALTHCHECK_INTERVAL_MS` | `60000` | How often to scan for instances with `state=open` but no `client.user`. |

### Chatbot integrations

| Variable | Default | Purpose |
|---|---|---|
| `CIRCUIT_BREAKER` | `true` | Enable opossum circuit breakers around chatbot POSTs. Set to `false` to disable. |
| `CIRCUIT_BREAKER_TIMEOUT_MS` | `30000` | Per-call timeout (mirrors each integration's axios timeout). |
| `CIRCUIT_BREAKER_ERROR_PCT` | `50` | Open the breaker when >50 % of recent calls fail. |
| `CIRCUIT_BREAKER_RESET_MS` | `30000` | Time before the breaker half-opens a probe. |
| `CIRCUIT_BREAKER_VOLUME` | `5` | Minimum recent-call count before the breaker can open. |
| `OPENAI_ASSISTANT_BUDGET_MS` | `90000` | Wall-clock cap on Assistant API run polling. Replaces a 60-iteration counter. |

### Storage & queues

| Variable | Default | Purpose |
|---|---|---|
| `S3_TIMEOUT_MS` | `60000` | Per-operation timeout for all MinIO / S3 calls (`putObject`, `presignedGetObject`, `removeObject`). |
| `RABBITMQ_MAX_QUEUE_LENGTH` | `0` (disabled) | If > 0, sets `x-max-length` + `x-overflow=drop-head` on all declared queues to cap unbounded growth when consumers lag. |

### WebSocket

| Variable | Default | Purpose |
|---|---|---|
| `WEBSOCKET_MAX_CONNECTIONS` | `5000` | Global Socket.io connection cap. Set `0` to disable. |
| `WEBSOCKET_MAX_CONNECTIONS_PER_IP` | `50` | Per-IP Socket.io connection cap. Set `0` to disable. |

### Metrics

| Variable | Default | Purpose |
|---|---|---|
| `METRICS` | `true` | Enable Prometheus `/metrics` endpoint and default Node.js process metrics. Set `false` to disable. |

---

## Endpoints added

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health/live` | none | Liveness probe. Always 200 as long as the process is up. |
| GET | `/health/ready` | none | Readiness probe. Runs `SELECT 1` against Prisma. Returns 200 / 503. |
| GET | `/metrics` | none | Prometheus scrape. Default Node.js metrics + custom gauges (`evolution_instances_by_state`, `evolution_messages_sent_total`, `evolution_chatbot_calls_total`, `evolution_reconnects_total`). |

**Security note**: none of these require the API key. Restrict them at the
firewall / network-policy layer, not in application code. This is intentional
so that K8s probes and Prometheus scrapers work without key rotation.

---

## Behavior changes worth knowing

### 1. Body size: 136 MB → 50 MB

Largest legitimate base64 WA media payload is ~22 MB. If your clients POST
larger JSON to `/send/media` or similar, bump `REQUEST_BODY_LIMIT_MB` —
don't revert to the old 136 MB default which let a single request OOM the
process.

### 2. Sends against a dead socket throw 400

Before: `client.sendMessage` silently queued against a closed WS; the caller
saw no error until the eventual timeout (minutes later).

Now: `sendMessageWithTyping` calls `ensureConnected()`, which waits up to 5 s
for the socket to open and then throws `BadRequestException` with state info.

If existing callers were built around the silent-queue semantics and can't be
changed quickly: `ENSURE_CONNECTED_ON_SEND=false`.

### 3. Message-receive pipeline no longer blocks on webhooks

Before: `eventManager.emit()` awaited each transport sequentially. A webhook
with exponential-backoff retries could park the pipeline for ~25 min.

Now: transports run concurrently (`Promise.allSettled`), and the webhook
transport schedules retries fire-and-forget. The caller returns as soon as
the request is scheduled, not when it eventually succeeds.

### 4. Bootstrap failures exit cleanly

Before: a missing DB produced a 4 kB Prisma stack dump and an ugly crash.

Now: `[SERVER] Cannot connect to database: Can't reach database server at X`
followed by `[SERVER] Bootstrap failed: ...` and `exit(1)`. PM2 / K8s will
restart.

### 5. Graceful shutdown on SIGTERM / SIGINT

25 s budget (K8s default `terminationGracePeriodSeconds` is 30 s). Closes,
in order:

1. Zombie detector interval
2. HTTP server (stop accepting new requests, drain existing)
3. All Baileys sockets (`ws.close`, `client.end`, `stopAllCronTasks`)
4. Prisma disconnect
5. Redis disconnect
6. Chatwoot Postgres pool disconnect

If the 25 s budget is exceeded, forces `exit(1)`.

### 6. `uncaughtException` exits the process

Default is log to Sentry + exit(1). Set `EXIT_ON_UNCAUGHT=false` in dev if
you prefer the old behavior.

---

## Deployment scenarios

### Kubernetes

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: evolution-api
      livenessProbe:
        httpGet: { path: /health/live, port: 8080 }
        initialDelaySeconds: 10
      readinessProbe:
        httpGet: { path: /health/ready, port: 8080 }
        initialDelaySeconds: 5
        periodSeconds: 10
      resources:
        limits: { memory: 2Gi, cpu: 2 }
        requests: { memory: 1Gi, cpu: 500m }
      env:
        - { name: TRUST_PROXY_HOPS, value: "1" }
        - { name: EXIT_ON_UNCAUGHT, value: "true" }
        - { name: METRICS, value: "true" }
```

Prometheus scrape: `/metrics`, intervals of 15–30 s are fine — the scrape
path iterates the instance map but the cost is linear and ~sub-ms up to a
few thousand instances.

### PM2 (single VM)

`ecosystem.config.js` ships in the repo. Enable with:

```bash
npm run build
pm2 start ecosystem.config.js --env production
```

PM2 cluster mode is **NOT supported** because Baileys state is in-memory per
instance. If you need horizontal scale, run multiple PM2 processes on
different ports behind a load balancer with sticky routing per instance.

### On-prem / bare metal (no reverse proxy)

Set `TRUST_PROXY_HOPS=0`. Otherwise any client can spoof `X-Forwarded-For`
and bypass the rate limiter.

---

## Tuning playbook

| Symptom | Tune |
|---|---|
| `/send/media` returns 413 | Bump `REQUEST_BODY_LIMIT_MB` |
| Legitimate clients hitting 429 | Bump `RATE_LIMIT_MAX` or widen `RATE_LIMIT_WINDOW_MS` |
| Status broadcasts too slow | Drop `STATUS_BATCH_DELAY_MS` (risk: WA ban) |
| Zombie detector false positives | Raise `INSTANCE_HEALTHCHECK_INTERVAL_MS` or disable |
| Circuit breaker opening on healthy endpoints | Raise `CIRCUIT_BREAKER_VOLUME` or `CIRCUIT_BREAKER_ERROR_PCT` |
| Prisma timeouts | Bump `DATABASE_STATEMENT_TIMEOUT` or `DATABASE_CONNECTION_LIMIT` |
| Large WA media not being inlined | Bump `WA_MEDIA_MAX_BYTES` |
| WA Business API sends failing where they used to succeed | Check logs — previously they were silently dropped and now surface as 500s. Fix the upstream error rather than reverting. |
| Sends returning 400 on known-connected instances | Temporarily `ENSURE_CONNECTED_ON_SEND=false` while debugging |

---

## Metrics exposed

At `GET /metrics`:

**Default Node.js** (from `prom-client.collectDefaultMetrics`):
- `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`
- `process_resident_memory_bytes`, `process_heap_bytes`
- `nodejs_eventloop_lag_seconds`, `nodejs_eventloop_lag_p*`
- `nodejs_gc_duration_seconds`, `nodejs_gc_pause_seconds`

**Custom**:
- `evolution_instances_by_state{state="open|connecting|close|..."}`
- `evolution_messages_sent_total{result="success|retry|error"}`
- `evolution_chatbot_calls_total{integration="openai|dify|...", result="success|error"}`
- `evolution_reconnects_total`

Counter-increment call sites in the code were left for a follow-up PR.
Default metrics are live; custom counters currently report 0 for most
labels because the increment hooks aren't wired yet.

---

## Smoke test checklist

Run these against a staging environment with real Postgres + Redis before
merging.

**Bootstrap**
- [ ] Server starts with valid DB + Redis → `/health/live` returns 200, `/health/ready` returns 200
- [ ] Server starts with DB down → one-line error, `exit(1)` (not a stack dump)
- [ ] Server starts with Redis down → logs attempts 1, 5, 10, 15, 20 only; HTTP still serves
- [ ] `kill -TERM $pid` → graceful shutdown log lines in order, exit 0 within 25 s

**WhatsApp**
- [ ] Pair an instance via QR
- [ ] Abandon the QR for > 5 min → pairing aborts with "budget exceeded"
- [ ] Send a text message → arrives, no timeout
- [ ] Send a 25 MB base64 video via `/send/media` → accepts (would have 413'd with 0414.3)
- [ ] Disconnect the instance's WhatsApp → `/send/text` returns 400 within 5 s (not a minute-long hang)
- [ ] Set `ENSURE_CONNECTED_ON_SEND=false` and repeat → old silent-queue behavior restored
- [ ] Force disconnect + reconnect cycle → observe "Zombie instance detected" only if reload flag isn't set

**Events**
- [ ] Configure an instance webhook pointing at a slow (2 s) endpoint, send 10 messages fast → no request handler starvation
- [ ] Configure an instance webhook at a dead endpoint, send 5 messages → retries log but don't block subsequent sends
- [ ] Rate-limit: send 700 requests in 1 min from one IP → 429 starts at request 601
- [ ] `TRUST_PROXY_HOPS=0` + spoofed `X-Forwarded-For` → rate limit still enforces on real peer IP

**WebSocket**
- [ ] Open 51 Socket.io connections from one IP → 51st rejected with "per-IP cap"
- [ ] (If you can) open 5001 connections total → global cap rejects

**Cleanup**
- [ ] Log out an instance → no "syncLostMessages" cron firing 30 min later
- [ ] Send SIGTERM with 10 instances connected → all 10 close cleanly in logs

---

## Known gaps (intentionally deferred)

Things the current branch does NOT fix. These are documented in CHANGELOG
commits or the `git log` but called out here for operators.

- **No unit tests.** All guards, retries, mutexes, and caps are
  reasoned-about-correctness only.
- **Session-store concurrency.** The `use-multi-file-auth-state-*.ts`
  backends have not been audited for concurrent writes to the same key.
  The `saveCredsChain` mutex serializes the Baileys-side call; the
  underlying store could still race if writes arrive from multiple paths.
- **Counter increment hooks.** Custom Prometheus counters are declared
  but the increment call sites aren't wired — follow-up PR.
- **Smoke test automation.** The checklist above is manual.
- **Custom metric cardinality.** `evolution_instances_by_state` is
  recomputed on every scrape; at > 5000 instances this starts to show as
  measurable event-loop pressure.

---

## Commit history

See `git log v2.3.7..v2.3.8-robustness.0414.5 --oneline` for the full list.

Key commits:
- `444eb9fb` HTTP server timeouts
- `d6a6c3dd` Graceful shutdown + Sentry + Redis reconnect
- `ed85cb1c` Prisma pool + statement timeout
- `78620b27` Chatbot 30 s timeouts
- `7de5f43f` Baileys double-reconnect fix
- `4a7d35ac` Helmet + rate limit + health endpoints
- `0257a476` S3/MinIO timeouts
- `e940b2c1` OpenAI Assistant wall-clock budget
- `a7ae1b3a` saveCreds mutex
- `3ee2956f` sendWithRetry + ensureConnected
- `4c25bbd7` Status-broadcast throttle
- `025d6970` Pairing budget
- `860eb0e1` Zombie detector
- `d9517265` Circuit breakers
- `bddea5a2` RabbitMQ max-length
- `38a3dee1` SQS awaited sendMessage
- `908d81f5` NATS reconnect
- `fd7286a5` Review fixes (batch 1)
- `48796b56` L1/L2/L3 regression fixes
- `27a2952e` WA Business error propagation
- `0623d029` Chatwoot pool + timeouts
- `b8935251` Baileys media cap + cache TTLs
- `c72122d1` Event manager parallelization
- `25c5c27c` WebSocket connection caps
- `92124d1a` Trust proxy conditional
- `e729330e` Cron cleanup
- `a834e793` Group cache scoping
