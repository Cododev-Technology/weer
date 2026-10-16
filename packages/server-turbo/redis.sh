#!/bin/bash

# Use this script to setup, stop, or resume a local Redis Cluster.
# Usage: ./redis.sh -setup | -stop | -resume [-prod]
# Example: ./redis.sh -setup -prod

CMD=$1
SYSTEM=$2 # set to -prod for redis6-server else it will be redis-server


CLUSTER_COUNT=6 # change this to set number of redis instances in cluster

END_PORT=$((7100 + CLUSTER_COUNT - 1)) # 7100, not 7000: on macOS, AirPlay Receiver listens on 7000


if [ "$SYSTEM" == "-prod" ]; then
  REDIS_SVR="redis6-server"
  REDIS_CLI="redis6-cli"
else
  REDIS_SVR="redis-server"
  REDIS_CLI="redis-cli"
fi

if [ "$CMD" == "-setup" ]; then
  mkdir -p ./target/redis-cluster
  cd ./target/redis-cluster

  for port in $(seq 7100 $END_PORT); do
    mkdir -p $port
    cat <<EOF > $port/redis.conf
port $port
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000

# Disable persistence so that data is not saved to disk
save ""
appendonly no

protected-mode no
bind 127.0.0.1
maxclients 100000
EOF
    $REDIS_SVR ./$port/redis.conf --daemonize yes --dir ./$port
  done

  sleep 5

  $REDIS_CLI --cluster create \
  $(for port in $(seq 7100 $END_PORT); do echo -n "127.0.0.1:$port "; done) \
  --cluster-replicas 1 --cluster-yes

elif [ "$CMD" == "-stop" ]; then
  for port in $(seq 7100 $END_PORT); do
    $REDIS_CLI -p $port shutdown 2>/dev/null
  done
  # (no pkill here: it would also stop the other Redis servers of this machine, like the one on 6379)

elif [ "$CMD" == "-resume" ]; then
  # Adjusted to point to the correct relative path
  for port in $(seq 7100 $END_PORT); do
    $REDIS_SVR ./target/redis-cluster/$port/redis.conf --daemonize yes --dir ./target/redis-cluster/$port
  done
else
  echo "Usage: ./redis.sh -setup | -stop | -resume"
fi
