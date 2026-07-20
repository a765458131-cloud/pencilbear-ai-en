module.exports = {
  apps: [
    {
      name: 'pencilbear-ai',
      cwd: '/www/pencilbear-ai/server',
      script: 'src/index.ts',
      // 用 tsx 作为 Node 加载器直接运行 TS
      interpreter: 'node',
      interpreter_args: '--import tsx',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
    },
  ],
};
