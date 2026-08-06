// PM2 ecosystem config for production runs of Evolution API.
//
// Usage:
//   pm2 start ecosystem.config.js --env production
//   pm2 reload evolution-api   # zero-downtime restart
//   pm2 logs evolution-api
//   pm2 monit
//
// Notes:
// - `script: dist/main.js` assumes a prior `npm run build` — production
//   should not run the tsx watcher.
// - `instances: 1` is the safe default because Evolution maintains in-memory
//   WhatsApp Baileys socket state per instance. Cluster mode with >1 worker
//   would fracture that state. If you truly need horizontal scale, run
//   multiple PM2 processes on different ports behind an LB with sticky
//   routing per WA instance name.
// - `max_memory_restart: 1G` catches Baileys session leaks before Node's
//   V8 heap crashes the process unpredictably.
// - `kill_timeout: 30_000` matches the graceful-shutdown budget in main.ts
//   so PM2 doesn't SIGKILL while we're still closing sockets cleanly.
// - `exp_backoff_restart_delay: 5000` avoids restart storms if startup is
//   failing (e.g. DB offline).

module.exports = {
  apps: [
    {
      name: 'evolution-api',
      script: 'dist/main.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 30000,
      wait_ready: false,
      listen_timeout: 30000,
      exp_backoff_restart_delay: 5000,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      // PM2 auto-aggregates these and rotates with pm2-logrotate.
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
