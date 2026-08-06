# Evolution API — Production Deploy Guide (robust-0414.5)

> **Audience**: another Claude Code instance (or a human operator) deploying
> the robust-0414 hardened image to a production server. Follow top to
> bottom. Do not skip verification steps.

---

## 0. What you are deploying

- **Image**: `shimonuziel/evolution-api:robust-0414.5`
- **Image digest**: `sha256:a08125ffe95f39ffd77c757a644474b046f845589785700ffead6cc7a87f328a`
- **Source branch**: `feat/robustness-0414` @ https://github.com/shimonu2/evolution-api
- **Architectures**: `linux/amd64`, `linux/arm64` (multi-arch manifest — Docker picks automatically).
- **Rolling tag**: `shimonuziel/evolution-api:robust` points at the latest robust build. Use the pinned `:robust-0414.5` in compose so automatic pulls don't silently change the running version.
- **What's new vs. `evoapicloud/evolution-api:latest`**: see `CHANGELOG.md` and `ROBUSTNESS.md` in this repo. 20+ new env vars, new `/health/*` and `/metrics` endpoints, graceful shutdown, circuit breakers, bounded retries, WebSocket caps.

---

## 1. Prerequisites on the production host

Run these checks before doing anything else:

```bash
# Docker 20.10+ required
docker --version

# Compose V2 required (docker compose, not docker-compose)
docker compose version

# Must be able to reach Docker Hub
docker pull shimonuziel/evolution-api:robust-0414.5

# Network requirements:
#  - Outbound HTTPS to registry-1.docker.io (image pull)
#  - Outbound to WhatsApp servers (Baileys)
#  - Outbound to any configured chatbot endpoints (OpenAI, Dify, etc.)
#  - Inbound: whatever external port you map to container :8080
```

If `docker pull` fails with `unauthorized` or `denied`, the image is now
PUBLIC on Docker Hub under `shimonuziel/evolution-api` so it should not
require a login. If it still fails, run `docker logout` then retry.

---

## 2. The docker-compose.yaml to use

Create a working directory on the host (e.g. `/opt/evolution-api`) and
drop this file in as `docker-compose.yaml`:

```yaml
# docker-compose.yaml
name: evolution-api

services:
  evolution-api:
    # PINNED tag — do not change to :robust or :latest in production unless
    # you want automatic version drift. Bump to the next pinned version
    # when you want to upgrade.
    image: shimonuziel/evolution-api:robust-0414.5
    container_name: evolution-api
    restart: always
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      # Only bind to localhost if there's a reverse proxy in front.
      # Use 0.0.0.0 only for direct public exposure (and then also set
      # strong CORS and enable rate limiting — see below).
      - "127.0.0.1:8080:8080"
    env_file:
      - .env
    # 30s matches the graceful-shutdown budget in the image.
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:8080/health/live"]
      interval: 15s
      timeout: 5s
      retries: 4
      start_period: 30s
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

  postgres:
    image: postgres:15-alpine
    container_name: evolution-postgres
    restart: always
    environment:
      POSTGRES_USER: evolution
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      POSTGRES_DB: evolution
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U evolution -d evolution"]
      interval: 5s
      timeout: 3s
      retries: 5
    # No port mapping — only evolution-api talks to it. Uncomment for
    # debugging only.
    # ports:
    #   - "127.0.0.1:5432:5432"

  redis:
    image: redis:7-alpine
    container_name: evolution-redis
    restart: always
    command:
      - redis-server
      - --appendonly
      - "yes"
      - --maxmemory
      - "256mb"
      - --maxmemory-policy
      - "allkeys-lru"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  postgres-data:
  redis-data:
```

Key facts about this compose file:
- `depends_on: condition: service_healthy` means evolution-api won't even
  start until Postgres and Redis are healthy — this prevents the bootstrap
  failure the image now handles cleanly anyway.
- `stop_grace_period: 30s` gives the in-image graceful shutdown (25 s
  internal budget) time to close sockets before Docker sends SIGKILL.
- Memory limit 2 GB is the PM2 rule-of-thumb for typical loads. Raise for
  heavy media traffic (base64 payloads are large).
- `json-file` logging is rotated so a runaway log can't fill the disk.

---

## 3. The `.env` file to use

Create `.env` in the same directory. **Replace every `CHANGE_ME` value.**

```bash
# ===== IDENTITY / AUTH (REQUIRED) =====
SERVER_URL=https://evolution.example.com
AUTHENTICATION_API_KEY=CHANGE_ME_to_a_32_char_random_string

# Generate with: openssl rand -hex 32

# ===== DATABASE (REQUIRED) =====
POSTGRES_PASSWORD=CHANGE_ME_strong_password
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://evolution:CHANGE_ME_strong_password@postgres:5432/evolution
# Same password as POSTGRES_PASSWORD above — compose passes it into postgres,
# the URI passes it into evolution-api.
DATABASE_CONNECTION_CLIENT_NAME=evolution-prod
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true

# Robust additions (safe defaults — tune under load):
DATABASE_CONNECTION_LIMIT=20
DATABASE_CONNECT_TIMEOUT=10
DATABASE_POOL_TIMEOUT=10
DATABASE_STATEMENT_TIMEOUT=15000

# ===== REDIS (REQUIRED) =====
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://redis:6379/6
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_REDIS_SAVE_INSTANCES=false
CACHE_LOCAL_ENABLED=false

# ===== HTTP / NETWORK =====
SERVER_PORT=8080
SERVER_TYPE=http
# CORS: lock to your frontends. Use * ONLY for local dev.
CORS_ORIGIN=https://your-frontend.example.com,https://your-manager.example.com
CORS_METHODS=GET,POST,PUT,DELETE
CORS_CREDENTIALS=true

# Robust additions:
REQUEST_BODY_LIMIT_MB=50
# Set to 0 if this container is NOT behind a reverse proxy. Otherwise
# X-Forwarded-For can be spoofed to bypass rate limiting.
TRUST_PROXY_HOPS=1
RATE_LIMIT_MAX=600
RATE_LIMIT_WINDOW_MS=60000

# ===== BAILEYS / WHATSAPP BEHAVIOR =====
CONFIG_SESSION_PHONE_CLIENT=Evolution
CONFIG_SESSION_PHONE_NAME=Chrome
CONFIG_SESSION_PHONE_VERSION=2.3000.1023204200
QRCODE_LIMIT=30
# Max QR retries — separate from the absolute timeout below.

# Robust additions:
ENSURE_CONNECTED_ON_SEND=true
PAIRING_BUDGET_MS=300000
STATUS_BATCH_DELAY_MS=200
WA_MEDIA_MAX_BYTES=52428800
INSTANCE_HEALTHCHECK=true
INSTANCE_HEALTHCHECK_INTERVAL_MS=60000

# ===== OPS / LIFECYCLE =====
EXIT_ON_UNCAUGHT=true
METRICS=true
# Set to false to disable /metrics entirely.

# ===== CHATBOT CIRCUIT BREAKER =====
CIRCUIT_BREAKER=true
CIRCUIT_BREAKER_TIMEOUT_MS=30000
CIRCUIT_BREAKER_ERROR_PCT=50
CIRCUIT_BREAKER_RESET_MS=30000
CIRCUIT_BREAKER_VOLUME=5

# ===== OPENAI (OPTIONAL — only if you use OpenAI chatbots) =====
OPENAI_ASSISTANT_BUDGET_MS=90000
OPENAI_ENABLED=false
# Set to true and provide a key to enable.
# OPENAI_API_KEY_GLOBAL=sk-...

# ===== EVENTS (fill in only what you use) =====
WEBSOCKET_ENABLED=true
WEBSOCKET_GLOBAL_EVENTS=false
WEBSOCKET_ALLOWED_HOSTS=*
WEBSOCKET_MAX_CONNECTIONS=5000
WEBSOCKET_MAX_CONNECTIONS_PER_IP=50

WEBHOOK_GLOBAL_ENABLED=false
# WEBHOOK_GLOBAL_URL=https://your.webhook.example.com
# WEBHOOK_EVENTS_ERRORS=true
# WEBHOOK_EVENTS_ERRORS_WEBHOOK=https://your.errors.example.com

RABBITMQ_ENABLED=false
# RABBITMQ_URI=amqp://user:pass@rabbitmq:5672
# RABBITMQ_MAX_QUEUE_LENGTH=0

SQS_ENABLED=false
NATS_ENABLED=false
KAFKA_ENABLED=false
PUSHER_ENABLED=false

# ===== STORAGE (OPTIONAL — for media persistence) =====
S3_ENABLE=false
# S3_ACCESS_KEY=...
# S3_SECRET_KEY=...
# S3_BUCKET=...
# S3_PORT=443
# S3_ENDPOINT=s3.amazonaws.com
# S3_REGION=us-east-1
# S3_USE_SSL=true
# S3_SKIP_POLICY=false
S3_TIMEOUT_MS=60000

# ===== CHATWOOT (OPTIONAL) =====
CHATWOOT_ENABLED=false
# CHATWOOT_MESSAGE_READ=true
# CHATWOOT_MESSAGE_DELETE=true
# CHATWOOT_BOT_CONTACT=true
# CHATWOOT_IMPORT_DATABASE_CONNECTION_URI=postgresql://...
CHATWOOT_PG_POOL_MAX=10

# ===== SENTRY (OPTIONAL but recommended in prod) =====
# SENTRY_DSN=https://...@sentry.io/...

# ===== LOG =====
LOG_LEVEL=ERROR,WARN,INFO
LOG_COLOR=true
LOG_BAILEYS=error
```

**Secrets checklist — before you bring up the stack:**
- [ ] `AUTHENTICATION_API_KEY` is a 32+ char random string
- [ ] `POSTGRES_PASSWORD` is strong and NOT the default
- [ ] `DATABASE_CONNECTION_URI` contains the same password as `POSTGRES_PASSWORD`
- [ ] `SERVER_URL` points to the public URL (used in webhooks + base URLs)
- [ ] `CORS_ORIGIN` is NOT `*` unless this is a dev box

---

## 4. First-time deploy (from scratch)

```bash
cd /opt/evolution-api

# 1. Pull images explicitly so any network issues surface NOW, not during up.
docker compose pull

# 2. Bring the stack up detached.
docker compose up -d

# 3. Watch the startup logs. You should see, in order:
#    - postgres: "database system is ready to accept connections"
#    - redis:    "Ready to accept connections"
#    - evolution-api:
#        [Prisma]   "Repository:Prisma - ON (pool=20 connect=10s statement=15000ms)"
#        [Redis]    "redis ready"
#        [Metrics]  "Metrics - ON (GET /metrics)"
#        [SERVER]   "trust proxy = 1 — set TRUST_PROXY_HOPS=0 if NOT behind a proxy"
#        [SERVER]   "HTTP - ON: 8080"
docker compose logs -f evolution-api | head -80

# 4. Verify the service is healthy (wait ~30s after `up`).
docker compose ps
#  evolution-api should show  (healthy)

# 5. Probe the endpoints from the host.
curl -sSf http://127.0.0.1:8080/health/live   # -> {"status":"ok"}
curl -sSf http://127.0.0.1:8080/health/ready  # -> {"status":"ready"}
curl -sS  http://127.0.0.1:8080/metrics | head -20  # -> prometheus text

# 6. Verify auth works.
curl -sS http://127.0.0.1:8080/instance/fetchInstances \
  -H "apikey: $AUTHENTICATION_API_KEY" | head -20
```

If any step fails, go to section 9 (Troubleshooting) before continuing.

---

## 5. Migrating FROM `evoapicloud/evolution-api:latest`

This is the path for operators already running the upstream image.

**The robust image is compatible in-place with the same Postgres DB and
same Redis** — but behavior changes from `ROBUSTNESS.md` §6 apply. Read
those first so you know what to expect.

### Steps

```bash
# 1. BACKUP the Postgres volume. This is the DB migration safety net.
docker compose exec postgres pg_dump -U evolution -d evolution \
  | gzip > backup-pre-robust-$(date +%Y%m%d-%H%M%S).sql.gz

# 2. Update docker-compose.yaml: change the image line
#    FROM:  image: evoapicloud/evolution-api:latest
#    TO:    image: shimonuziel/evolution-api:robust-0414.5

# 3. Add the new env vars to .env (copy from section 3 of this doc, keep
#    your existing overrides).

# 4. Pull the new image.
docker compose pull evolution-api

# 5. Recreate only the evolution-api container (postgres + redis keep state).
docker compose up -d --no-deps evolution-api

# 6. Watch for the "Repository:Prisma - ON" + "HTTP - ON" lines.
docker compose logs -f evolution-api | head -60

# 7. Verify previously-paired instances reconnect.
curl -sS http://127.0.0.1:8080/instance/fetchInstances \
  -H "apikey: $AUTHENTICATION_API_KEY" | jq '.[] | {name, connectionStatus}'
```

### Expected differences from upstream

- Bootstrap is noisier on startup (logs include pool size, Metrics ON,
  trust-proxy mode — all informational).
- `POST /message/sendText/{instance}` on a disconnected instance now
  returns **400** instead of hanging. If your caller treated the old
  silent behavior as success, set `ENSURE_CONNECTED_ON_SEND=false` and
  plan to migrate the caller later.
- `/send/media` accepting base64 now caps at 50 MB (tunable via
  `REQUEST_BODY_LIMIT_MB`).
- On `SIGTERM`, the container takes up to ~25 s to shut down cleanly.
  Docker's `stop_grace_period: 30s` covers this. **Do not** `docker kill`
  during normal operation.

---

## 6. Verification checklist after deploy

Work through this end-to-end before declaring success.

### Infrastructure
- [ ] `docker compose ps` shows all three services `(healthy)`
- [ ] `curl /health/live` returns `{"status":"ok"}` HTTP 200
- [ ] `curl /health/ready` returns `{"status":"ready"}` HTTP 200
- [ ] `curl /metrics` returns `# HELP nodejs_...` text
- [ ] `docker compose exec evolution-api wget -qO- http://127.0.0.1:8080/health/ready` works from inside

### Graceful shutdown
```bash
# 1. Note the container ID.
docker compose ps evolution-api

# 2. Send SIGTERM (do NOT use docker stop -t 0).
docker compose kill -s SIGTERM evolution-api

# 3. In a second terminal, watch logs.
docker compose logs -f evolution-api
```
Expected log sequence (should all appear within 25 s):
```
[SERVER] Received SIGTERM, starting graceful shutdown (max 25000ms)...
[SERVER] HTTP server closed.
[SERVER] Baileys instances closed.
[PrismaRepository] Repository:Prisma - OFF
[Redis]    redis connection ended
[SERVER] Shutdown complete.
```

### WhatsApp pairing
```bash
# Create an instance.
curl -sS -X POST http://127.0.0.1:8080/instance/create \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"smoke-test","integration":"WHATSAPP-BAILEYS"}' | jq

# Fetch the QR as data URL, open it in a browser, scan with WhatsApp.
curl -sS http://127.0.0.1:8080/instance/connect/smoke-test \
  -H "apikey: $AUTHENTICATION_API_KEY" | jq -r '.qrcode.base64' | head -c 200
```

- [ ] QR scan completes within a minute; connection state goes to `open`
- [ ] If you abandon QR > 5 min, the pairing aborts with "budget exceeded" in logs (new robust behavior)
- [ ] `sendText` to your own number arrives on WhatsApp
- [ ] `sendText` against a disconnected instance returns HTTP 400 fast (not a minute-long hang)

### Observability
- [ ] Prometheus scraper configured to hit `/metrics` every 15-30 s
- [ ] Sentry (if configured) receives a test event after you trigger an error
- [ ] `docker compose logs evolution-api` shows the custom format with color codes
- [ ] Log rotation is active — check with `docker inspect evolution-api | jq '.[0].HostConfig.LogConfig'`

---

## 7. Rollback procedure

If something's wrong and you need to revert:

```bash
# If you backed up the DB in section 5, you probably don't need to restore
# it — the robust image is compatible with the same schema. Rolling the
# image back is usually enough.

# 1. Change the image tag back in docker-compose.yaml:
#    image: evoapicloud/evolution-api:latest
# (or whatever pinned upstream version you were on).

# 2. Pull and recreate.
docker compose pull evolution-api
docker compose up -d --no-deps evolution-api

# 3. Watch logs — upstream image will just ignore the new env vars in .env
#    (most are unknown to it). No harm.
docker compose logs -f evolution-api | head -60

# 4. ONLY if you also need to restore the DB (very rare — only if the
#    robust image somehow corrupted data, which it shouldn't):
docker compose down
docker volume rm evolution-api_postgres-data
docker compose up -d postgres
sleep 10
gunzip < backup-pre-robust-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U evolution -d evolution
docker compose up -d
```

---

## 8. Updating to a newer robust version

When a newer `shimonuziel/evolution-api:robust-0414.N` is published:

```bash
cd /opt/evolution-api

# 1. Read the CHANGELOG diff in the repo between your current tag and
#    the new one (GitHub: feat/robustness-0414 branch, CHANGELOG.md).

# 2. Update the pinned tag in docker-compose.yaml.
sed -i 's|shimonuziel/evolution-api:robust-0414\.5|shimonuziel/evolution-api:robust-0414.N|' docker-compose.yaml

# 3. Pull and roll.
docker compose pull evolution-api
docker compose up -d --no-deps evolution-api

# 4. Verify against section 6.
```

**Never use `:robust` or `:latest` in compose for production.** Those
tags float. `docker compose pull` on a restart would silently move you
to a new version without you noticing.

---

## 9. Troubleshooting (by symptom)

### `docker pull` returns `unauthorized`
Image is public now. Run `docker logout` and retry.

### Container keeps restarting with "Bootstrap failed: Can't reach database server"
- Postgres isn't up yet (check `docker compose ps postgres`).
- `DATABASE_CONNECTION_URI` hostname wrong — inside the compose network it should be `postgres:5432`, not `localhost` or `127.0.0.1`.
- Password mismatch — `POSTGRES_PASSWORD` and the password in the URI must match character for character.

### Startup log shows "Cannot connect to database" but psql works
The image connects from *inside* the container. `localhost:5432` in `DATABASE_CONNECTION_URI` means "inside the container" — it should be `postgres:5432` (the service name).

### Health check never goes `(healthy)`
- `curl http://container-ip:8080/health/live` manually (`docker compose exec evolution-api wget -qO- http://127.0.0.1:8080/health/live`).
- If 503 on `/health/ready`, the DB is unreachable — see previous items.
- If the endpoint doesn't exist (404), the image is pre-robust. Verify `docker compose images` shows `shimonuziel/evolution-api:robust-0414.5`.

### Logs spam `redis reconnect attempt N in Xms`
Redis is unreachable. In this image the log is already throttled — if you see every attempt, the image is pre-robust.

### Sends suddenly fail with 400 "is not connected"
Expected new behavior. Two options:
1. Fix the actual connection (check WA instance status).
2. Revert to silent-queue behavior per-container: `ENSURE_CONNECTED_ON_SEND=false` in `.env`, then `docker compose up -d --no-deps evolution-api`.

### `/send/media` returns 413 on large base64 videos
Bump `REQUEST_BODY_LIMIT_MB` (default 50). WhatsApp's own cap is 16 MB of binary media, so 50 MB of base64 is enough. If you're trying to send something larger, it won't make it through WhatsApp anyway.

### Legit clients hit 429 rate-limit
Either bump `RATE_LIMIT_MAX` (default 600/min per IP) or widen `RATE_LIMIT_WINDOW_MS`. If behind a proxy and all requests look like they're from the proxy IP, fix `TRUST_PROXY_HOPS` — it should be set to the number of proxy hops in front (usually 1).

### Container uses 2 GB+ RAM quickly
Likely Baileys media leak under high-throughput inbound media. Check that `WA_MEDIA_MAX_BYTES` is set (default 50 MB). If you're getting lots of > 50 MB inbound media, raise that cap but also raise the container memory limit.

### Status broadcast gets the number banned
`STATUS_BATCH_DELAY_MS` default 200. Raise to 500-1000 ms if broadcasting to > 500 contacts regularly.

### WebSocket client gets "Too many connections"
You hit `WEBSOCKET_MAX_CONNECTIONS` (global) or `WEBSOCKET_MAX_CONNECTIONS_PER_IP` (per-IP). Bump the relevant cap.

### Shutdown logs show "Graceful shutdown timed out — forcing exit"
Either increase `stop_grace_period` in compose AND the internal 25 s budget (not env-configurable — would need an image rebuild), OR investigate which teardown step is hanging. `Prisma disconnect` hanging usually means a long-running query; `Redis disconnect` hanging usually means a socket error.

---

## 10. Reverse proxy notes

If you put this behind nginx / Caddy / Traefik:

```nginx
# nginx
upstream evolution_api {
  server 127.0.0.1:8080;
}

server {
  listen 443 ssl;
  server_name evolution.example.com;

  # Match the container's body limit.
  client_max_body_size 50m;

  # WebSocket upgrade for Socket.io.
  location / {
    proxy_pass http://evolution_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }

  # Optionally deny /metrics from the public internet.
  location /metrics {
    allow 10.0.0.0/8;  # your monitoring subnet
    deny all;
    proxy_pass http://evolution_api;
  }
}
```

If you end up with **two** proxy hops (e.g. CDN → nginx → evolution-api),
set `TRUST_PROXY_HOPS=2`.

---

## 11. Monitoring setup

### Prometheus (scrape)
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'evolution-api'
    scrape_interval: 30s
    static_configs:
      - targets: ['evolution-api:8080']
    metrics_path: /metrics
```

### Key alerts

Reasonable starter thresholds:

| Metric | Alert when |
|---|---|
| `up{job="evolution-api"}` | `== 0 for 2m` (service down) |
| `nodejs_eventloop_lag_p99_seconds` | `> 0.2 for 5m` (event loop saturated) |
| `process_resident_memory_bytes` | `> 1.8e9 for 10m` (OOM risk) |
| `evolution_instances_by_state{state="open"}` | `< (expected_count * 0.8) for 5m` (instances dropping) |
| `nodejs_gc_pause_seconds_count` | `rate > 10/s for 5m` (GC thrash) |

### Dashboards
Import a generic Node.js Prometheus dashboard from Grafana Labs (`1860`
or similar), then add panels for the `evolution_*` custom metrics.

---

## 12. Things that are INTENTIONALLY not automated

- **Secret rotation**. `AUTHENTICATION_API_KEY` and `POSTGRES_PASSWORD` change manually; document your cadence.
- **Backups**. The compose here does not schedule backups. Add a cron job that runs the `pg_dump` command from section 5 nightly.
- **TLS**. The container serves HTTP on 8080. TLS termination is the reverse proxy's job.
- **Multi-replica horizontal scale**. Baileys keeps session state in memory per process. You cannot just `docker compose up --scale evolution-api=3` — instance routing would break. Run multiple compose stacks on different ports behind an LB with sticky routing per instance, or use the provider-files backend for session sharing (separate setup).

---

## 13. Fast answers to likely questions

**Q: Can I run this with MySQL instead of Postgres?**
Yes — set `DATABASE_PROVIDER=mysql` and update the connection URI. Note that `DATABASE_STATEMENT_TIMEOUT` does NOT apply to MySQL (it's Postgres-specific).

**Q: Can I disable Redis?**
Yes — `CACHE_REDIS_ENABLED=false` and `CACHE_LOCAL_ENABLED=true`. You lose cross-process cache sharing and the group metadata cache becomes in-process-only. Fine for single-container deployments.

**Q: What happens if I omit a new env var?**
Safe defaults kick in. The defaults are chosen so a 0-config upgrade from upstream behaves sensibly in production.

**Q: Why is the container 2 GB of memory?**
Node heap + Baileys buffers + media retention. 1 GB is tight under any significant media traffic. Raise to 4 GB if you see OOM.

**Q: How do I confirm I'm running the robust image and not upstream?**
```bash
docker compose images evolution-api
# Should show: shimonuziel/evolution-api  robust-0414.5
docker compose exec evolution-api cat package.json | grep version
# Should show: "version": "2.3.8-robustness.0414.5"
```
The `/health/*` and `/metrics` endpoints only exist on the robust image — if those return 404, you're running upstream.

---

## 14. Useful one-liners

```bash
# Tail logs for just evolution-api
docker compose logs -f --tail=100 evolution-api

# Grep logs for errors
docker compose logs evolution-api | grep -E "ERROR|WARN"

# Shell into the container
docker compose exec evolution-api sh

# Check env inside the container
docker compose exec evolution-api env | grep -iE "database|redis|rate|trust"

# Force a hard restart (SIGTERM → graceful → start)
docker compose restart evolution-api

# Apply .env changes (recreates container, keeps volumes)
docker compose up -d --force-recreate --no-deps evolution-api

# Clean everything (DANGER: deletes data)
docker compose down -v
```

---

## 15. When to escalate

Open an issue on https://github.com/shimonu2/evolution-api/issues if:
- Bootstrap clean-shutdown hangs past the 30 s compose grace period
- The zombie detector fires repeatedly on an instance that IS actually connected
- Circuit breakers open on endpoints you know are healthy
- Prometheus shows a monotonically growing memory curve with steady load
- Any 5xx response from `/health/live` (should not be possible)

Include:
- Image digest (`docker compose images evolution-api --digests`)
- Last 200 log lines
- `.env` with secrets redacted
- `curl /metrics | head -200` output
