use cpeak::{Value, json};

use crate::helpers::supertest::Agent;

// What the server sends back for a new link:
//   URLId: number;
//   code: string;
//   realURL: string;
//   linkType: LinkType;
//   expiresAt: string | null;
pub type CreatedUrl = Value;

// The id of a link that the server sent back, as the number it is in the database
pub fn url_id(url: &CreatedUrl) -> i32 {
    url["URLId"].as_i64().unwrap() as i32
}

// A value that the server sent back as text (like the code of a link), the way a column
// of the database has it: text, or NULL
pub fn text(value: &Value) -> Option<String> {
    value.as_str().map(String::from)
}

pub async fn create_classic_link(
    agent: &Agent,
    url: impl Into<Option<&'static str>>,
) -> CreatedUrl {
    let url = url.into().unwrap_or("http://www.example.com");
    let res = agent
        .post("/url")
        .send(json!({ "url": url, "type": "classic" }))
        .await;
    res.body
}
