# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Weer is a production-grade URL shortener built as a monorepo. It serves as the first real-world application for the **Cpeak** framework — a zero-dependency Node.js framework developed alongside this project. The backend is PostgreSQL-backed; the frontend is React with Webpack.

You will not change comments, the logic or code style in any shape or form. If you have to and it is absolutely necessary, you need to get a confirmation first. Your main job is to handle the drudgery and repetitive work, not to invent things on your own. If you see something that is wrong, you can point it out, but DO NOT change it without confirmation.

This is a yarn project and all project commands should be run with `yarn`.

## Monorepo Structure

```
packages/
  server/    # Cpeak/Node.js backend API
  web/       # React frontend (compiled to server/public/scripts/)
  styles/    # SASS → CSS pipeline (compiled to server/public/styles.css)
  common/    # Shared TypeScript types (LinkType enum, etc.)
  reusable/  # Shared React component library
```

## Commands

### Development

```bash
# Start server with auto-reload
cd packages/server && yarn dev

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

# Run frontend tests
cd packages/web && yarn test
```

### Building (production)

```bash
# Build everything in dependency order: reusable → common → web → styles → server
yarn build   # from root

# Build individual packages
cd packages/server && yarn build   # tsc -p .
cd packages/web && yarn build   # webpack --mode production
cd packages/styles && yarn build
```

### Database

```bash
# Initialize/seed the database
cd packages/server && yarn seed
```

## Architecture

### Request Flow

1. Static assets (HTML, CSS, JS bundle) served from `packages/server/public/`
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

Link generation logic lives in `packages/server/src/lib/links.ts`. URL controller logic (creation, type changes) is in `packages/server/src/controllers/url.ts`.

### Database

PostgreSQL with a connection pool defined in `packages/server/src/database/index.ts`. Schema SQL files are in `src/database/tables/`. No ORM — raw SQL queries throughout. Study the packages/server/src/database/index.ts file before dealing with any database-related code.

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
