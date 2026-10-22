#!/bin/sh

# Downloads the free DB-IP country database (IP address to country), which the servers read for
# the stats of the links. DB-IP publishes a new one every month, so run this once a month. The
# servers read it when they start.
#
# License: CC BY 4.0. The stats link to DB-IP for it ("IP geolocation by DB-IP").

set -e

DIR="$(dirname "$(readlink -f "$0")")"
FILE="$DIR/dbip-country-lite.mmdb"

download() {
  curl -fsSL -o "$FILE.gz" "https://download.db-ip.com/free/dbip-country-lite-$1.mmdb.gz" &&
    gunzip -c "$FILE.gz" > "$FILE.tmp"
}

this_month="$(date -u +%Y-%m)"
# (GNU date, then the BSD date of macOS)
last_month="$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m 2>/dev/null || date -u -v1d -v-1m +%Y-%m)"

# This month's file comes out in the first days of the month, until then last month's is the newest
if download "$this_month" || download "$last_month"; then
  mv "$FILE.tmp" "$FILE"
  rm -f "$FILE.gz"
  echo "Saved $FILE"
else
  rm -f "$FILE.gz" "$FILE.tmp"
  echo "Couldn't download the DB-IP country database." >&2
  exit 1
fi
