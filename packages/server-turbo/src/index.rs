use server_turbo::app::app;

fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(2080);

    let server = app().listen(port, || {
        cpeak::log(format!(
            "Starting the server...\n----------------------------------\nServer has started on port {port}\n----------------------------------"
        ));
        println!("Server is on port {port}");
    });

    // Rust stops when main returns, so we wait here for as long as the server runs
    server.wait();
}
