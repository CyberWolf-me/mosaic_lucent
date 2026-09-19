module.exports = {
  apps: [
    {
      name: 'lucent-server',
      script: './packages/server/dist/main.js',
      cwd: '/home/opc/lucent',
      instances: 4,
      exec_mode: 'cluster',
      node_args: '--env-file=packages/server/.env',
      env: {
        NODE_ENV: 'production',
        PORT: '4387',
        LUCENT_DATABASE_POOL_MAX: '2',
      },
      max_memory_restart: '1G',
      listen_timeout: 10000,
      kill_timeout: 5000,
    },
  ],
};
