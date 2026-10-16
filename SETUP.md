# Setup

Pick the setup method that fits your use case. Uou only need one:

- [Docker](#docker)
- [Natively — Production](#natively--production)
- [Natively — Development](#natively--development)

---

## Docker

**Prerequisites:** Docker, Docker Compose

1. Copy the example environment file and fill in your values:
   ```
   cp packages/server-shared/.env.example packages/server-shared/.env
   ```
2. Run the setup script:
   ```
   ./docker-run.sh
   ```

The script will prompt you to seed the database (required on first run) and choose a start mode (PM2 or single Node process).

---

## Natively — Production

**Prerequisites:** Node.js, PostgreSQL, Redis, yarn, PM2

Set your environment variables either via AWS Parameter Store or by copying the example file:

```
cp packages/server-shared/.env.example packages/server-shared/.env
```

Then:

```
yarn setup
yarn start
```

`yarn setup` installs dependencies, builds all packages, and seeds the database. `yarn start` launches the server under PM2.

---

## Natively — Development

**Prerequisites:** Node.js, PostgreSQL, Redis, yarn

1. Copy the example environment file and fill in your values:
   ```
   cp packages/server-shared/.env.example packages/server-shared/.env
   ```
2. First-time setup (install, build, seed):
   ```
   yarn setup
   ```
3. Start the watchers in separate terminal tabs:
   ```
   cd packages/server && yarn dev   # server with auto-reload
   cd packages/web && yarn dev      # webpack watcher
   cd packages/styles && yarn dev   # Sass watcher
   ```

If editing shared types or components, also run in additional tabs:

```
cd packages/common && yarn dev
cd packages/reusable && yarn dev
```
