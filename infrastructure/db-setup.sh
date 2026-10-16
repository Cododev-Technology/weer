#!/bin/bash

# The database machine: PostgreSQL for the server.
# Connect with pgAdmin through an ssh tunnel: ssh -i key.pem -N -L 5433:localhost:5432 ubuntu@<db>
# then localhost:5433, user postgres, no password.

set -ex

apt-get install -y postgresql

CONF=$(ls -d /etc/postgresql/*/main)

# Listen on the private network too, not only on localhost
echo "listen_addresses = '*'" >> "$CONF/postgresql.conf"

# No password from the machines of this subnet (the server) or from an ssh tunnel (localhost).
# On top, since the first line that matches wins.
sed -i '1i host all all samenet trust' "$CONF/pg_hba.conf"
sed -i '1i host all all ::1/128 trust' "$CONF/pg_hba.conf"
sed -i '1i host all all 127.0.0.1/32 trust' "$CONF/pg_hba.conf"

systemctl restart postgresql
