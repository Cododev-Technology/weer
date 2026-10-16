use std::fs;

use cpeak::json;

use crate::helpers::supertest::request;
use crate::helpers::target::app;
use crate::setup_each_test::test;

const PUBLIC_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../server-shared/public");

fn read(file: &str) -> Vec<u8> {
    fs::read(format!("{PUBLIC_PATH}{file}")).unwrap()
}

mod pages_and_static_files {
    use super::*;

    #[test]
    fn should_show_the_home_page() {
        test(async {
            let res = request(app()).get("/").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-type"), Some("text/html"));
            assert_eq!(res.bytes, read("/index.html"));
        });
    }

    #[test]
    fn should_show_the_terms_and_the_privacy_pages() {
        test(async {
            for page in ["terms", "privacy"] {
                let res = request(app()).get(&format!("/{page}")).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.header("content-type"), Some("text/html"));
                assert_eq!(res.bytes, read(&format!("/{page}.html")));
            }
        });
    }

    #[test]
    fn should_serve_the_files_of_the_public_folder() {
        test(async {
            let files = [
                ("/index.html", "text/html"),
                ("/404.html", "text/html"),
                ("/logo.svg", "image/svg+xml"),
                ("/google-icon.svg", "image/svg+xml"),
                ("/favicons/favicon.ico", "image/x-icon"),
                ("/favicons/favicon-96x96.png", "image/png"),
                ("/favicons/site.webmanifest", "application/manifest+json"),
            ];

            for (file, mime) in files {
                let res = request(app()).get(&format!("{file}?v=1")).await;

                assert_eq!(res.status_code, 200, "{file}");
                assert_eq!(res.header("content-type"), Some(mime), "{file}");
                assert!(read(file) == res.bytes, "{file}");
            }
        });
    }

    #[test]
    fn should_compress_the_pages_for_the_browsers_that_ask_for_it() {
        test(async {
            // (a request that sets Accept-Encoding itself gets the response the way the server
            // sent it, with its Content-Encoding header and still compressed)
            let res = request(app()).get("/").set("Accept-Encoding", "gzip").await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-encoding"), Some("gzip"));
            assert_eq!(res.header("vary"), Some("Accept-Encoding"));
            // Every gzip file starts with these two bytes
            assert_eq!(res.bytes[..2], [0x1f, 0x8b]);
            assert!(res.bytes.len() < read("/index.html").len());

            // Without that header the client asks for gzip as well, and unzips what it gets
            let unzipped = request(app()).get("/").await;
            assert_eq!(unzipped.bytes, read("/index.html"));

            let plain = request(app())
                .get("/")
                .set("Accept-Encoding", "identity")
                .await;

            assert_eq!(plain.header("content-encoding"), None);
            assert_eq!(plain.bytes, read("/index.html"));
        });
    }

    #[test]
    fn should_show_the_404_page_for_a_path_that_does_not_exist() {
        test(async {
            let responses = [
                request(app()).get("/this/does/not/exist").await,
                request(app()).get("/scripts/nope.js").await,
                request(app())
                    .post("/this-is-not-a-route")
                    .send(json!({ "a": 1 }))
                    .await,
                request(app()).delete("/auth/status").await,
            ];

            for res in responses {
                assert_eq!(res.status_code, 404);
                assert_eq!(res.header("content-type"), Some("text/html"));
                assert_eq!(res.bytes, read("/404.html"));
            }
        });
    }
}
