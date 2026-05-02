#!/bin/sh

is_yes() { case "$1" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac }

ENV_FILE="packages/server/.env"

# ─── .env check ───────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo ""
  echo "  packages/server/.env not found."
  echo "  Copy the example and fill in your values:"
  echo ""
  echo "    cp packages/server/.env.example packages/server/.env"
  echo ""
  exit 1
fi

# ─── Seed? ────────────────────────────────────────────────────────────────────
printf "\n  Seed the database? Type 'y' for first time setup. WARNING: all existing data will be deleted. [y/N]: "
read -r answer
if is_yes "$answer"; then
  SEED_DB=true
else
  SEED_DB=false
  echo "  Skipping database seed."
fi

# ─── Start mode? ──────────────────────────────────────────────────────────────
printf "\n  Start with PM2 (cluster) or single Node process? [pm2/node, default: node]: "
read -r answer
if [ "$answer" = "pm2" ]; then
  START_MODE=pm2
else
  START_MODE=node
fi

# ─── Build? ───────────────────────────────────────────────────────────────────
printf "\n  Rebuild Docker image? [y/N]: "
read -r answer
if is_yes "$answer"; then
  BUILD_FLAG="--build"
else
  BUILD_FLAG=""
fi

# ─── Run ──────────────────────────────────────────────────────────────────────
echo ""
if [ "$START_MODE" = "pm2" ]; then
  # PM2 manages the janitor inside the app container via ecosystem.config.cjs
  PROFILE_FLAG=""
  LOGS_SERVICES="app"
else
  # Node mode: janitor runs as a separate Docker service
  PROFILE_FLAG="--profile node"
  LOGS_SERVICES="app janitor"
fi

SEED_DB=$SEED_DB START_MODE=$START_MODE docker compose $PROFILE_FLAG up -d $BUILD_FLAG


printf "\nYou can now close this terminal tab and the server will keep running in the background.\n"
printf "For shell access run: docker exec -it weer sh\n"
printf "To view environment variables run: docker exec -it weer printenv\n"
printf "To view logs again after closing this session run: docker compose $PROFILE_FLAG logs -f $LOGS_SERVICES\n"
if [ "$START_MODE" = "pm2" ]; then
  printf "To view janitor logs only: docker exec -it weer pm2 logs janitor\n"
fi
printf "To nuke everything Docker created (containers, image, volumes): docker compose --profile node down --rmi all --volumes\n\n"


docker compose $PROFILE_FLAG logs -f $LOGS_SERVICES

