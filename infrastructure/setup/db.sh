#!/bin/bash

# The database machine: PostgreSQL for the server.
# Connect with pgAdmin through an ssh tunnel: ssh -i key.pem -N -L 5433:localhost:5432 ubuntu@<db>
# then localhost:5433, user postgres, no password.

set -ex

apt-get install -y postgresql

CONF=$(ls -d /etc/postgresql/*/main)

# Listen on the private network too, not only on localhost
echo "listen_addresses = '*'" >> "$CONF/postgresql.conf"

# Some database tuning for handing 1 million HTTP requests per second
cat >> "$CONF/postgresql.conf" <<'EOF'
shared_buffers = 16GB
wal_buffers = 256MB
max_wal_size = 16GB
min_wal_size = 4GB
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9
wal_compression = lz4
max_connections = 1000 # room for the url-shortener repo's pool (200) and the Node.js server's (48 workers x 16)
EOF

# No password from the machines of this subnet (the server) or from an ssh tunnel (localhost).
# On top, since the first line that matches wins.
sed -i '1i host all all samenet trust' "$CONF/pg_hba.conf"
sed -i '1i host all all ::1/128 trust' "$CONF/pg_hba.conf"
sed -i '1i host all all 127.0.0.1/32 trust' "$CONF/pg_hba.conf"

systemctl restart postgresql
