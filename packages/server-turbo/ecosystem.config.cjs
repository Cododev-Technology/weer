module.exports = {
  apps: [
    {
      name: "weer",
      script: "target/release/index",
      interpreter: "none",
      // Cpeak for Rust runs on every CPU core already, so one process is the whole cluster
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },
    {
      name: "janitor",
      script: "target/release/janitor",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
    },
  ],
};
