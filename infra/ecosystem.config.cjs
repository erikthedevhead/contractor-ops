// PM2 process file. Run as the `fc` user from the app directory:
//   pm2 start infra/ecosystem.config.cjs && pm2 save
// Day 5 adds co-estimator here.
module.exports = {
  apps: [
    {
      name: 'co-core', // API (OAuth, webhooks) + job worker
      cwd: __dirname + '/..',
      script: 'apps/core/src/main.ts',
      interpreter: 'node',
      interpreter_args: '--env-file=.env --import tsx',
      max_memory_restart: '350M',
      kill_timeout: 15000, // lets the worker finish its in-flight job on reload
      // A config error must not spin the CPU on a shared box: crashing within
      // 10s counts as unstable; 10 unstable restarts and PM2 gives up.
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,
      time: true,
    },
    {
      name: 'co-office-manager', // user-facing agent; reaches data only via co-core's MCP endpoint
      cwd: __dirname + '/..',
      script: 'apps/office-manager/src/main.ts',
      interpreter: 'node',
      interpreter_args: '--env-file=.env --import tsx',
      max_memory_restart: '300M',
      kill_timeout: 15000,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 2000,
      time: true,
    },
  ],
};
