#!/bin/bash

# The tester: Node.js and weer, for the stressor. Then ssh in and:
#   cd weer/packages/stressor
#   yarn classic-w --url http://<server_private_ip>:2080 --workers 8 --connections 400 ...

set -ex

# As the ubuntu user, in its home folder
sudo -u ubuntu -i bash <<'EOF'
set -ex

# Node.js and yarn
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 24
corepack enable yarn

# weer, with its packages (autocannon for the stressor)
git clone -b 1m-rps https://github.com/Cododev-Technology/weer.git
cd weer
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn install
EOF
