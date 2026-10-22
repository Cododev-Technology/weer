module.exports = {
  apps: [
    {
      name: "weer",
      script: "dist/index.js",
      instances: "max",
      exec_mode: "cluster",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },
    {
      name: "janitor",
      script: "dist/janitor/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // With the Redis cluster, the drain threads (a V8 of their own each, about 30 MB idle) with
      // their batches in flight took up to 2.6 GB with 12 threads (see janitor/cluster.ts)
      max_memory_restart: "4G",
    },
  ],
};