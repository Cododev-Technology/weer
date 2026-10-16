use redis::cluster::{ClusterClient, ClusterConfig};
use redis::cluster_async::ClusterConnection;

use crate::config::keys::KEYS;

// server-turbo runs with a Redis cluster (the nodes in REDIS_CLUSTER_NODES), and only when
// REDIS is true.
//
// Every thread gets a connection of its own, so each worker thread of Cpeak sends its own
// commands, instead of all of them going through one thread. A command is sent like this:
//   redis::cmd("XLEN").arg(key).query_async::<u64>(&mut connection()).await
thread_local! {
    static CONNECTION: ClusterConnection = connect();
}

pub fn connection() -> ClusterConnection {
    CONNECTION.with(ClusterConnection::clone)
}

// A new connection to the cluster, for the ones that shouldn't be shared, like the janitor's
// that wait for new views with BLOCK. It has to be made in async code: it lives on the event
// loop it was made on.
pub fn connect() -> ClusterConnection {
    let client = ClusterClient::new(KEYS.redis_cluster_nodes.clone()).unwrap_or_else(|error| {
        panic!("REDIS_CLUSTER_NODES is not a list of the nodes of a Redis cluster: {error}")
    });

    // It connects in the background, and the first command waits for it. There's no response
    // timeout, so a command can take as long as it needs, like XREADGROUP that waits for new
    // messages.
    client.get_pending_async_connection_with_config(ClusterConfig::new())
}

// Lets us know at startup whether the cluster can be reached
pub async fn check_connection() {
    match redis::cmd("PING")
        .query_async::<String>(&mut connection())
        .await
    {
        Ok(_) => println!("[redis] connected successfully"),
        Err(err) => eprintln!("[redis] connection error: {err}"),
    }
}
