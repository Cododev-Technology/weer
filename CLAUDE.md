# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Weer is a production-grade URL shortener built as a monorepo. It serves as the first real-world application for the **Cpeak** framework — a zero-dependency Node.js framework developed alongside this project. The backend is PostgreSQL-backed; the frontend is React with Webpack.

You will not change comments, the logic or code style in any shape or form. If you have to and it is absolutely necessary, you need to get a confirmation first. Your main job is to handle the drudgery and repetitive work, not to invent things on your own. If you see something that is wrong, you can point it out, but DO NOT change it without confirmation.

This is a yarn project and all project commands should be run with `yarn`.

## Monorepo Structure

```
packages/
  server/        # Cpeak/Node.js backend API
  server-turbo/  # Cpeak/Rust port of server/
  server-shared/ # Files both servers share: .env, env.sh, SQL tables, email templates, public/
  web/           # React frontend (compiled to server-shared/public/scripts/)
  styles/        # SASS → CSS pipeline (compiled to server-shared/public/styles.css)
  common/        # Shared TypeScript types (LinkType enum, etc.) and config/ (JSON5 link definitions, username limits, domain allowlist)
  reusable/      # Shared React component library
```

## server-turbo

`packages/server-turbo/` is a Rust port of `packages/server/`, built on Cpeak for Rust. It should mirror the Node.js server and act the same way, except for:

- **Redis mode**: the Node.js server runs Redis in single mode (`REDIS_URL`), while server-turbo runs it in cluster mode (`REDIS_CLUSTER_NODES`). This means the janitor is different too: in a cluster a key lives on one node, so server-turbo spreads the views over `VIEWS_STREAM_SHARDS` streams (`weer:stream:views:0`, `weer:stream:views:1`, ...) instead of the Node.js server's single `weer:stream:views`, and its janitor drains each of them in a loop of its own. When the Node.js server's views stream or janitor changes, make the same change in server-turbo, adapted to the shards.
- **Link caching**: server-turbo caches links in the Redis cluster (`src/redis/links-cache.rs`). The Node.js server has no link caching and doesn't need it.

## Commands

### Development

```bash
# Start server with auto-reload
cd packages/server && yarn dev

# Or start server-turbo with auto-reload instead (same .env and port as the Node.js server)
cd packages/server-turbo && yarn dev

# Set up, stop or resume the local Redis cluster that server-turbo uses when REDIS=true
cd packages/server-turbo && ./redis.sh -setup   # or -stop, -resume

# Build and watch frontend (run in separate terminal)
cd packages/web && yarn dev

# Build and watch styles (run in separate terminal)
cd packages/styles && yarn dev

# Build and watch shared types
cd packages/common && yarn dev
```

### Testing

```bash
# Run all server tests
cd packages/server && yarn test

# Run a single test file
cd packages/server && yarn mocha --extension ts __tests__/routes.test.ts --timeout 10000

# Run all server-turbo tests (same weer_test database as the Node.js tests, so never run both at once)
cd packages/server-turbo && yarn test

# Run a single server-turbo test file (its module name in __tests__/mod.rs)
cd packages/server-turbo && yarn test url_test

# Run frontend tests
cd packages/web && yarn test
```

### Building (production)

```bash
# Build everything in dependency order: reusable → common → web → styles → server → server-turbo → server-turbo's precompress (.br/.gz copies of server-shared/public/)
yarn build   # from root

# Build individual packages
cd packages/server && yarn build   # tsc -p .
cd packages/server-turbo && yarn build   # cargo build --release
cd packages/web && yarn build   # webpack --mode production
cd packages/styles && yarn build
```

### Database

```bash
# Initialize/seed the database
cd packages/server && yarn seed
# or the same with server-turbo
cd packages/server-turbo && yarn seed
```

## Architecture

### Request Flow

1. Static assets (HTML, CSS, JS bundle) served from `packages/server-shared/public/`
2. All API routes defined in `packages/server/src/router.ts` and handled by controllers in `src/controllers/`
3. Redirect routes (`/:id`, `/:username/:id`, `/q/:id`) hit the database and issue HTTP redirects
4. Auth via Google OAuth 2.0 using Passport.js; sessions stored in cookies via `cookie-session`

### Link Types

The core domain concept is `LinkType` (defined in `packages/common/src/types.ts`):

- **classic** — random short code
- **custom** — user-chosen code
- **affix** — `/{username}/{code}` format
- **ultra** — extremely short code
- **digit** — numeric code
- **qr** — QR code based link

Link generation logic lives in `packages/server/src/lib/links.ts`. The properties of each link type (`LINKS`) are in `packages/common/config/links.json5`: common's build turns it into JSON for the web and the Node.js server, and server-turbo's `build.rs` turns it into Rust constants. URL controller logic (creation, type changes) is in `packages/server/src/controllers/url.ts`.

### Database

PostgreSQL with a connection pool defined in `packages/server/src/database/index.ts`. Schema SQL files are in `packages/server-shared/database/tables/`. No ORM — raw SQL queries throughout. Study the packages/server/src/database/index.ts file before dealing with any database-related code.

### Configuration

Environment-specific config is split between `packages/server/src/config/dev.ts` and `prod.ts`, selected via `keys.ts`. The `dev.ts` file is gitignored — you'll need to create it locally with the appropriate environment variables.

### Frontend State

The React app uses React Context for global state:

- `AuthContext.tsx` — authentication state
- `UrlContext.tsx` — URL list management
- `ModalContext.tsx` — modal visibility

### Middleware

`packages/server/src/middlewares.ts` contains authentication guards and URL ownership validation used across routes.

## Deployment

- **Production**: PM2 cluster mode (`ecosystem.config.js`)
- **CI/CD**: AWS CodeBuild (`buildspec.yml`) + CodeDeploy (`appspec.yml`)
- Deploy scripts in `scripts/` handle start/stop/deploy lifecycle (when not using AWS CodeBuild & CodeDeploy).
