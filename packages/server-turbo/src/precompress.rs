// The web and styles packages build into the public folder of server-shared, so both servers serve that one
const PUBLIC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../server-shared/public");

// Writes the .br and .gz copies of the files in the public folder, which the server then
// sends as they are instead of compressing a file again for every request
fn main() {
    match cpeak::precompress(PUBLIC_PATH) {
        Ok(written) => {
            println!("[precompress] wrote {written} compressed copies in the public folder.")
        }
        Err(err) => {
            eprintln!("{err:?}");
            std::process::exit(1);
        }
    }
}
