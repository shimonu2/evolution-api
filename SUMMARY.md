# Robust-0414 — Master Summary

> Single-page index of everything that shipped in the `feat/robustness-0414`
> branch, plus exactly where to look for each piece of detail.

---

## What this is

A hardening pass on the upstream Evolution API codebase. **No new product
features.** Every change targets one of: hangs, crashes, resource leaks,
silent message loss, observability gaps, or operational ergonomics.

- **Branch**: [`feat/robustness-0414`](https://github.com/shimonu2/evolution-api/tree/feat/robustness-0414)
- **PR**: [#1](https://github.com/shimonu2/evolution-api/pull/1)
- **Final version**: `2.3.8-robustness.0414.5`
- **Status**: code-complete, documented, live-startup verified, **untested against real WhatsApp traffic** (see "Honest gaps" below)

---

## Where to find what

| If you want to… | Read |
|---|---|
| Deploy to production | [`DEPLOY.md`](./DEPLOY.md) |
| Tune env vars / understand behavior changes | [`ROBUSTNESS.md`](./ROBUSTNESS.md) |
| See what shipped in each release | [`CHANGELOG.md`](./CHANGELOG.md) |
| Use the Docker image | [`DEPLOY.md` §0](./DEPLOY.md#0-what-you-are-deploying) |
| Understand a single bug fix | `git log feat/robustness-0414` (commit messages are detailed) |

---

## Releases shipped

| Tag | Date | Theme | Commits |
|---|---|---|---|
| `v2.3.8-robustness.0414` | 2026-04-14 | Initial hardening: HTTP timeouts, graceful shutdown, Prisma + Redis, Baileys reconnect race, chatbot timeouts, helmet + rate limit + health endpoints | 8 |
| `v2.3.8-robustness.0414.2` | 2026-04-14 | Round 2: SQL refactor, logger safety, S3 timeouts, OpenAI wall-clock, saveCreds mutex, sendWithRetry, status throttling, QR pairing budget, zombie detector, circuit breakers, RabbitMQ queue cap, SQS/NATS fixes, PM2 config, Prometheus metrics, npm audit | 17 |
| `v2.3.8-robustness.0414.3` | 2026-04-15 | Self-audit fixes: pairing reset, saveCreds chain, metrics idempotence, NATS rejection handler, zombie race guard, sendWithRetry cap, ANSI strip | 7 |
| `v2.3.8-robustness.0414.4` | 2026-04-15 | Live-run regressions: body limit 5→50mb, bootstrap failure cleanup, Redis log throttle, WA Business error throws, Chatwoot pool dispose + timeouts, Baileys media cap + cache TTLs | 7 |
| `v2.3.8-robustness.0414.5` | 2026-04-15 | Caller-blocking + DoS: event-manager parallelization, webhook fire-and-forget, WebSocket connection caps, trust-proxy conditional, cron cleanup, ensureConnected opt-out, group-cache scoping | 7 |

**Total**: ~46 commits across 30+ files.

---

## Docker images on Docker Hub

All under `shimonuziel/evolution-api`. Multi-arch: `linux/amd64` + `linux/arm64`.

| Tag | Use |
|---|---|
| `robust-0414.5` | **Recommended for production compose.** Pinned, immutable. |
| `0414.5` | Same image, shorter alias. |
| `v2.3.8-robustness.0414.5` | Same image, matches git tag exactly. |
| `robust` | Rolling tag. Updates on each robust release. Use for dev, NOT prod compose. |

Image digest: `sha256:a08125ffe95f39ffd77c757a644474b046f845589785700ffead6cc7a87f328a`

---

## What's actually different from upstream

### Lifecycle
- HTTP server timeouts (keepAlive, headers, request, maxConnections)
- Graceful SIGTERM/SIGINT shutdown (HTTP → Baileys → Prisma → Redis → Chatwoot Postgres) with 25s budget
- `uncaughtException` → Sentry + exit(1)
- Bootstrap failures → one clean error line + exit(1) (no Prisma stack dump)
- PM2 ecosystem config

### HTTP / network
- helmet middleware
- express-rate-limit (600/min/IP default, tunable)
- Body limit 136mb → 50mb default (was a brief 5mb regression in 0414.3, reverted)
- Conditional `trust proxy` via `TRUST_PROXY_HOPS`
- `/health/live`, `/health/ready`, `/metrics` endpoints

### Database (Prisma)
- Connection pool sizing
- Connect, pool, statement timeouts (Postgres-only for statement)
- Pipes Prisma warn/error events through app logger
- Chatwoot Postgres pool now disposed on shutdown

### Cache (Redis)
- Real reconnect strategy (progressive backoff, capped attempts)
- Connect timeout
- Log throttling (attempts 1, 5, 10, 15, 20)
- AggregateError unwrap
- `disconnect()` for graceful shutdown

### Baileys (WhatsApp Web)
- Removed duplicate `connection.update` listener (root cause of the zombie-instance race)
- Per-event try/catch in event handler (one event failure doesn't break the batch)
- `ensureConnected()` pre-send guard with opt-out
- `sendWithRetry()` for transport errors only (with bounded retry window)
- `saveCreds()` mutex
- Per-instance `groupMetadataCache` scoping
- Status broadcast throttling (`STATUS_BATCH_DELAY_MS`)
- Absolute QR pairing budget (`PAIRING_BUDGET_MS`)
- Media inlining size cap (`WA_MEDIA_MAX_BYTES`)
- Cache TTLs (`msgRetryCounterCache`, `userDevicesCache`)
- Cron jobs tracked + stopped on logout
- Zombie instance detector with reload race guard
- Defensive socket cleanup before reconnect

### WhatsApp Business API
- `post()` now throws on failure (was silently returning undefined)
- Media download bounded (size + timeouts)

### Chatbot integrations
- 30s timeouts on OpenAI / Dify / Flowise / N8N / Typebot / EvoAI / EvolutionBot
- Per-endpoint circuit breakers (opossum)
- OpenAI Assistant runs bounded by wall-clock instead of iteration count
- Chatwoot axios calls timeout + size capped

### Storage
- S3/MinIO `withTimeout()` wrapper

### Event queues
- RabbitMQ optional `x-max-length` for queue overflow control
- SQS converted from callback-style to awaited `SendMessageCommand`
- NATS unlimited reconnect + status observation + `closed()` rejection handler
- Event manager runs all 7 transports concurrently (`Promise.allSettled`)
- Webhook retries fire-and-forget (no longer blocks message-receive pipeline)

### WebSocket
- Global + per-IP connection caps

### Observability
- Prometheus `/metrics` (default Node.js metrics + custom gauges)
- Logger wrapped in `safeLog` (broken stdout can't crash process)
- ANSI codes stripped in stderr fallback

### Security / dependencies
- npm audit: 66 → 5 findings (all dev-only commitizen transitives)
- Override forces `@figuro/chatwoot-sdk` to use top-level safe axios
- `executeRawUnsafe` refactored to tagged `$executeRaw`

---

## Behavior changes that callers may notice

These are listed in `ROBUSTNESS.md` and `DEPLOY.md`. Repeat here for emphasis:

1. **Body size default 50mb** (was 136mb). Tunable via `REQUEST_BODY_LIMIT_MB`.
2. **Sends to disconnected instances throw 400** (used to silently queue). Opt out with `ENSURE_CONNECTED_ON_SEND=false`.
3. **WA Business sends throw on failure** (used to return `undefined`). No opt-out — fix the upstream issue or let the error surface.
4. **`SIGTERM` triggers graceful shutdown** (up to 25s). `docker stop -t 0` will lose in-flight work.
5. **`uncaughtException` exits the process** by default. `EXIT_ON_UNCAUGHT=false` to disable.
6. **Webhook delivery is fire-and-forget** from the message-receive perspective. Caller no longer blocks on retries.
7. **Pre-existing `:latest` Docker tag is unchanged.** You must opt into the robust image by changing the compose `image:` line.

---

## All ~23 new env vars

Quick reference. Full table in [`ROBUSTNESS.md`](./ROBUSTNESS.md).

```
# HTTP / bootstrap
REQUEST_BODY_LIMIT_MB=50
TRUST_PROXY_HOPS=1
RATE_LIMIT_MAX=600
RATE_LIMIT_WINDOW_MS=60000
EXIT_ON_UNCAUGHT=true

# Database
DATABASE_CONNECTION_LIMIT=20
DATABASE_CONNECT_TIMEOUT=10
DATABASE_POOL_TIMEOUT=10
DATABASE_STATEMENT_TIMEOUT=15000
CHATWOOT_PG_POOL_MAX=10

# Baileys
ENSURE_CONNECTED_ON_SEND=true
PAIRING_BUDGET_MS=300000
STATUS_BATCH_DELAY_MS=200
WA_MEDIA_MAX_BYTES=52428800
INSTANCE_HEALTHCHECK=true
INSTANCE_HEALTHCHECK_INTERVAL_MS=60000

# Chatbots
CIRCUIT_BREAKER=true
CIRCUIT_BREAKER_TIMEOUT_MS=30000
CIRCUIT_BREAKER_ERROR_PCT=50
CIRCUIT_BREAKER_RESET_MS=30000
CIRCUIT_BREAKER_VOLUME=5
OPENAI_ASSISTANT_BUDGET_MS=90000

# Storage / queues
S3_TIMEOUT_MS=60000
RABBITMQ_MAX_QUEUE_LENGTH=0

# WebSocket
WEBSOCKET_MAX_CONNECTIONS=5000
WEBSOCKET_MAX_CONNECTIONS_PER_IP=50

# Metrics
METRICS=true
```

These are also embedded in [`.env.example`](./.env.example) at the bottom.

---

## Honest gaps (still on the table)

The branch ships with these known limitations. Documented for transparency.

1. **No unit tests.** All retries, mutexes, guards, and caps are reasoned-about-correctness only.
2. **Never paired a real WA instance during this session.** The reconnect race fix, QR budget, saveCreds mutex, zombie detector, sendWithRetry — none have been validated against actual WhatsApp traffic.
3. **No load test.** No proof that throttles don't degrade legitimate throughput, no proof the rate limiter actually trips.
4. **No real SIGTERM smoke test against a running server with connections.** Code path written, never exercised.
5. **Custom Prometheus counters declared but not yet wired** to increment call sites. Default Node.js metrics work; the `evolution_messages_sent_total` etc. report zero.
6. **Session-store concurrency not audited** — `use-multi-file-auth-state-*.ts` backends could race outside the saveCreds mutex if writes arrive from multiple paths.
7. **Sentry handler ordering** — `Sentry.setupExpressErrorHandler` runs after our custom error handler. May not catch errors the custom handler swallows. Not verified.

The Tracking Issue: when ready to close these, do it in a follow-up PR.

---

## Smoke test before merging to main

Per [`DEPLOY.md` §6](./DEPLOY.md#6-verification-checklist-after-deploy):

1. Bring up compose stack with real Postgres + Redis.
2. Hit `/health/live` and `/health/ready`.
3. Pair a real WA instance via QR.
4. Send/receive at least one message of each type (text, image, video).
5. Force a Redis kill mid-flight; confirm logs throttle, no crash.
6. Force a Postgres kill mid-flight; confirm `/health/ready` returns 503.
7. `kill -TERM $pid`; confirm graceful shutdown log sequence within 25s.
8. Open 51 WebSocket connections from one IP; confirm 51st is rejected.

Take screenshots of each verification and attach to the PR before merging.

---

## How to cite this work

If another instance of Claude (or a human) needs the canonical reference:

> Robust-0414 hardening of Evolution API, branch `feat/robustness-0414`,
> tag `v2.3.8-robustness.0414.5`, image
> `shimonuziel/evolution-api:robust-0414.5` digest
> `sha256:a08125ffe95f39ffd77c757a644474b046f845589785700ffead6cc7a87f328a`.
> See `DEPLOY.md`, `ROBUSTNESS.md`, `CHANGELOG.md`, `SUMMARY.md` at repo
> root.

---

## Operational reminders

- **Rotate the GitHub PAT** that was originally embedded in your `git config`. The push completed via `gh auth`'s OAuth, but the original PAT may still be valid and was visible in shell output.
- **Pin `:robust-0414.5` in compose**, not `:robust` or `:latest`. Floating tags silently move you to new versions on every redeploy.
- **Set `stop_grace_period: 30s`** in compose so Docker doesn't SIGKILL during graceful shutdown.
- **Lock `CORS_ORIGIN`** to your actual frontends in production. The default upstream value tolerates `*` which is unsafe with credentials.
