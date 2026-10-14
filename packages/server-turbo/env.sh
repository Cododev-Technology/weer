#!/bin/sh

# This script loads environment variables either from a local .env file (for development) 
# or from AWS SSM (for production), and then executes the given command.

if [ "${DOCKER:-false}" = "true" ]; then
    echo "Running in Docker: Environment variables already injected by Docker Compose..."
elif [ -f .env ]; then
    echo "Running Locally: Loading environment variables from .env file..."
    set -a

    # source is not available in dash, so we use . instead.
    . ./.env

    set +a
else
    # Production environment: Load from AWS
    echo "Running in Production: Loading environment variables from AWS SSM..."
    set -a
    eval "$(aws ssm get-parameters-by-path \
        --path "/weer/prod/" \
        --with-decryption \
        --output json | jq -r '.Parameters[] | (.Name | ltrimstr("/weer/prod/")) + "=" + (.Value | @sh)')" || exit 1
    set +a
fi

# take all remaining arguments and run them as a command
exec env "$@"

