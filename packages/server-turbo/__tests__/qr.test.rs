use cpeak::json;

use server_turbo::database::index::POOL;

use crate::helpers::factories::url::url_id;
use crate::helpers::factories::user::create_user;
use crate::helpers::supertest::{Agent, request};
use crate::helpers::target::app;
use crate::setup_each_test::test;

// A destination on the domain allowlist, so the server never has to ask the Web Risk API about it
const URL: &str = "https://github.com/agile8118/weer";

// Creates a link for a new anonymous session, and returns its QR code id as well
async fn create_link() -> (Agent, i64, String) {
    let agent = request::agent(app());
    agent.get("/auth/status").await;
    let body = agent
        .post("/url")
        .send(json!({ "url": URL, "type": "classic" }))
        .await
        .body;
    let qr_code_id = sqlx::query_scalar::<_, String>("SELECT qr_code_id FROM urls WHERE id = $1")
        .bind(url_id(&body))
        .fetch_one(&*POOL)
        .await
        .unwrap();
    (agent, body["URLId"].as_i64().unwrap(), qr_code_id)
}

// The width and height of a PNG image are in its first chunk (IHDR)
fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(png[..8], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert_eq!(&png[12..16], b"IHDR");
    (
        u32::from_be_bytes(png[16..20].try_into().unwrap()),
        u32::from_be_bytes(png[20..24].try_into().unwrap()),
    )
}

mod qr_codes {
    use super::*;

    #[test]
    fn should_send_the_qr_code_of_a_link_as_an_svg() {
        test(async {
            let (agent, id, _) = create_link().await;

            let res = agent.get(&format!("/qr/{id}")).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-type"), Some("image/svg+xml"));
            assert_eq!(res.header("content-disposition"), None);

            // How the code is drawn is up to the package that draws it, so only the SVG around it is checked
            let svg = &res.text;
            let tag = svg
                .split(r#"<svg xmlns="http://www.w3.org/2000/svg""#)
                .nth(1)
                .and_then(|rest| rest.split('>').next())
                .unwrap_or_else(|| panic!("no <svg> tag in {svg:?}"));

            // The drawing is a square: viewBox="0 0 41 41"
            let (width, height) = tag
                .split(r#" viewBox="0 0 "#)
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .and_then(|size| size.split_once(' '))
                .unwrap_or_else(|| panic!("no viewBox in <svg{tag}>"));
            assert!(!width.is_empty() && width.bytes().all(|byte| byte.is_ascii_digit()));
            assert_eq!(width, height);

            assert!(svg.trim_end().ends_with("</svg>"));
        });
    }

    #[test]
    fn should_send_the_same_svg_every_time() {
        test(async {
            let (agent, id, _) = create_link().await;

            let first = agent.get(&format!("/qr/{id}")).await;
            let second = agent.get(&format!("/qr/{id}?type=svg&size=1024")).await;

            assert_eq!(first.text, second.text);
        });
    }

    #[test]
    fn should_send_the_qr_code_as_a_png_of_512_pixels_by_default() {
        test(async {
            let (agent, id, _) = create_link().await;

            for query in ["?type=png", "?type=png&size=300", "?type=png&size=abc"] {
                let res = agent.get(&format!("/qr/{id}{query}")).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.header("content-type"), Some("image/png"));
                assert_eq!(png_size(&res.bytes), (512, 512));
            }
        });
    }

    #[test]
    fn should_send_the_qr_code_as_a_png_of_the_given_size() {
        test(async {
            let (agent, id, _) = create_link().await;

            for size in [256, 512, 1024, 2048] {
                let res = agent.get(&format!("/qr/{id}?type=png&size={size}")).await;

                assert_eq!(res.status_code, 200);
                assert_eq!(res.header("content-type"), Some("image/png"));
                assert_eq!(png_size(&res.bytes), (size, size));
            }
        });
    }

    #[test]
    fn should_send_the_qr_code_as_a_file_to_download() {
        test(async {
            let (agent, id, qr_code_id) = create_link().await;

            let svg = agent.get(&format!("/qr/{id}?download=true")).await;
            assert_eq!(svg.status_code, 200);
            assert_eq!(
                svg.header("content-disposition"),
                Some(format!("attachment; filename=\"{qr_code_id}.svg\"").as_str())
            );

            let png = agent
                .get(&format!("/qr/{id}?download=true&type=png&size=256"))
                .await;
            assert_eq!(png.status_code, 200);
            assert_eq!(
                png.header("content-disposition"),
                Some(format!("attachment; filename=\"{qr_code_id}.png\"").as_str())
            );

            // Only when it's exactly "true"
            let inline = agent.get(&format!("/qr/{id}?download=1")).await;
            assert_eq!(inline.header("content-disposition"), None);
        });
    }

    #[test]
    fn should_send_the_qr_code_of_a_link_of_a_logged_in_user() {
        test(async {
            let agent = request::agent(app());
            create_user(&agent, None).await;
            let body = agent
                .post("/url")
                .send(json!({ "url": URL, "type": "classic" }))
                .await
                .body;

            let res = agent.get(&format!("/qr/{}", body["URLId"])).await;

            assert_eq!(res.status_code, 200);
            assert_eq!(res.header("content-type"), Some("image/svg+xml"));
        });
    }

    #[test]
    fn should_not_send_the_qr_code_of_the_link_of_someone_else() {
        test(async {
            let (_, id, _) = create_link().await;

            let user = request::agent(app());
            create_user(&user, None).await;

            for agent in [user, request::agent(app())] {
                let res = agent.get(&format!("/qr/{id}?type=png")).await;

                assert_eq!(res.status_code, 403);
                assert_eq!(res.header("content-type"), Some("application/json"));
                assert_eq!(
                    res.text,
                    json!({ "error": "Not allowed to access." }).to_string()
                );
            }
        });
    }
}
