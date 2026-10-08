// PM2 process file. Run as the `fc` user from the app directory:
//   pm2 start infra/ecosystem.config.cjs && pm2 save
// Day 3+ adds co-office-manager and co-estimator here.
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
      time: true,
    },
  ],
};
