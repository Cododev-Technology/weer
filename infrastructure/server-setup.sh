#!/bin/bash

# The server: Redis, Node.js, Rust and weer. Then ssh in and:
#   cd weer
#   cp packages/server-shared/.env.example packages/server-shared/.env   and fill it in (DB_HOST=<db_private_ip>)
#   yarn setup
#   yarn start:rust

set -ex

# Redis (the Node.js server uses this one on 6379, server-turbo the cluster below)
apt-get install -y lsb-release curl gpg
curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/redis.list
apt-get update
apt-get install -y redis

# The rest as the ubuntu user, in its home folder
sudo -u ubuntu -i bash <<'EOF'
set -ex

# Node.js, yarn and pm2
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24
corepack enable yarn
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn -v # downloads yarn now, so yarn setup doesn't ask to
npm i -g pm2

# Rust
curl https://sh.rustup.rs -sSf | sh -s -- -y

# weer
git clone -b 1m-rps https://github.com/Cododev-Technology/weer.git

# The Redis cluster of server-turbo (7100-7105). After a reboot: ./redis.sh -resume
cd weer/packages/server-turbo
./redis.sh -setup
EOF
