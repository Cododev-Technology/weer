#!/bin/sh

# @TODO, on ubuntu /bin/sh is dash, which doesn't support arrays. We should switch to bash or rewrite this script to be compatible with dash.

# This script loads environment variables either from a local .env file (for development) 
# or from AWS SSM (for production), and then executes the given command.

if [ "${DOCKER:-false}" = "true" ]; then
    echo "Running in Docker: Environment variables already injected by Docker Compose..."
elif [ -f .env ]; then
    echo "Running Locally: Loading environment variables from .env file..."
    set -a
    source .env
    set +a
else
    # Production environment: Load from AWS
    echo "Running in Production: Loading environment variables from AWS SSM..."
    export $(aws ssm get-parameters-by-path \
        --path "/weer/prod/" \
        --with-decryption \
        --query "Parameters[*].[Name,Value]" \
        --output text | awk '{print $1"="$2}' | sed 's|/weer/prod/||') || exit 1
fi

# take all remaining arguments and run them as a command
exec env "$@"

