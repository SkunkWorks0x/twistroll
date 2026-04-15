// ecosystem.config.cjs
//
// pm2 process config for the TWiSTroll server. Production supervisor:
//   - Auto-restart on crash (up to 10 times/minute before backoff)
//   - Memory guardrail: restart if RSS exceeds 1500MB (stays well under
//     the 2GB node cap documented in data/diagnostics/oom-hunt-findings.md,
//     and well above the observed 282MB steady-state plateau)
//   - Exponential restart delay (pm2 default: 100ms → 16s cap)
//   - Persistent log paths under data/logs/pm2/ for post-mortems
//   - Loads .env via dotenv at boot (pm2 doesn't auto-load .env the way
//     `npm run dev` does via dotenv in config.ts; we run tsx directly here)
//
// Usage:
//   pm2 start ecosystem.config.cjs       # first run
//   pm2 restart twistroll                 # manual restart
//   pm2 logs twistroll --lines 200        # tail logs
//   pm2 monit                             # live dashboard
//   pm2 stop twistroll                    # stop
//   pm2 delete twistroll                  # remove from pm2 registry
//   pm2 save                              # persist list across reboots
//   pm2 startup                           # generate OS-level autostart (asks for sudo)
//
// The `env` block below mirrors what npm run dev picks up via dotenv in
// config.ts. pm2 will merge these with process.env, with .env values
// winning via the pre-load hook.

const path = require('path');
const fs = require('fs');

// Read .env at config-load time (pm2 parses this file in Node, not a shell).
// Using a minimal dotenv-style parser so we don't add a dependency.
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding single/double quotes if present
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: 'twistroll',
      cwd: __dirname,

      // Run tsx directly — faster startup than going through npm run.
      // npm run dev would fork a shell + npm + tsx; tsx alone skips two
      // processes, which shortens recovery time on crash-restart.
      script: 'node_modules/.bin/tsx',
      args: 'src/server/index.ts',

      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10,             // 10 restarts per minute, then backoff
      restart_delay: 500,           // initial delay; pm2 bumps it exponentially
      min_uptime: '10s',            // must stay up this long before counting as "stable"
      kill_timeout: 5000,           // SIGKILL 5s after SIGTERM if not exited

      // Memory guardrail. Per oom-hunt-findings.md the server plateaus at
      // ~282MB RSS; anything past 1500MB signals a genuine leak, not normal
      // warmup. pm2 restarts cleanly — overlay reconnects via the
      // production-grade WS reconnect shipped in commit 55e8f4e.
      max_memory_restart: '1500M',

      // Watch is NOT enabled — tsx+our own code handles hot-reload during
      // `npm run dev`. pm2 watch would double-fire restarts and fight
      // chokidar.
      watch: false,

      // Logs — absolute paths under data/logs/pm2/. Directory auto-created
      // at startup by the server if missing (see server startup).
      out_file: path.join(__dirname, 'data', 'logs', 'pm2', 'out.log'),
      error_file: path.join(__dirname, 'data', 'logs', 'pm2', 'error.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',

      env: loadEnv(),
    },
  ],
};
