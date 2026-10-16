// Turns the JSON5 files that we share with the Node.js server (and the front end) into Rust
// constants, so the values are written in one place and are still constants here. The files
// that include them: lib/link-definitions.rs, lib/validation.rs, lib/domain-allowlist.rs and
// database/schema.rs.
use std::env;
use std::fs;
use std::path::Path;

use serde_json::Value;

// Reads a JSON5 file (plain JSON is valid JSON5 too)
fn read(path: &str) -> Value {
    println!("cargo::rerun-if-changed={path}");
    json5::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn write(file: &str, code: String) {
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join(file), code).unwrap();
}

// A JSON array of strings is already a Rust array of &str: ["a","b"]
fn strings(declaration: &str, list: &Value) -> String {
    format!(
        "{declaration}: [&str; {}] = {list};\n",
        list.as_array().unwrap().len()
    )
}

// A type of link whose codes we generate ourselves (Link in lib/link-definitions.rs)
fn link(link: &Value) -> String {
    let conversions: Vec<String> = link["conversions"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(from, to)| format!("({from:?}, {to})"))
        .collect();
    let valid_for = match link["validFor"].as_i64() {
        Some(milliseconds) => format!("Some({milliseconds})"),
        None => "None".to_string(),
    };

    format!(
        "Link {{ characters: {}, max_length: {}, min_length: {}, requires_auth: {}, conversions: &[{}], valid_for: {valid_for} }}",
        link["characters"],
        link["maxLength"],
        link["minLength"],
        link["requiresAuth"],
        conversions.join(", ")
    )
}

// A type of link whose codes the user picks (Picked in lib/link-definitions.rs)
fn picked(link: &Value) -> String {
    let reserved_words = match &link["reservedWords"] {
        Value::Null => "[]".to_string(),
        words => words.to_string(),
    };

    format!(
        "Picked {{ min_length: {}, max_length: {}, requires_auth: {}, reserved_words: &{reserved_words} }}",
        link["minLength"], link["maxLength"], link["requiresAuth"]
    )
}

fn main() {
    let links = read("../common/config/links.json5");
    let qr = &links["qr"];
    let character_encoding = match qr["characterEncoding"].as_str() {
        Some("base64url") => "base64url_encode",
        other => panic!("there is no Rust function for the character encoding {other:?}"),
    };
    write(
        "links.rs",
        format!(
            "pub const LINKS: Links = Links {{ classic: {}, ultra: {}, digit: {}, custom: {}, affix: {}, qr: Qr {{ character_encoding: {character_encoding}, length: {}, size: {} }} }};\n",
            link(&links["classic"]),
            link(&links["ultra"]),
            link(&links["digit"]),
            picked(&links["custom"]),
            picked(&links["affix"]),
            qr["length"],
            qr["size"]
        ),
    );
    write(
        "reserved_route_segments.rs",
        strings(
            "pub const RESERVED_ROUTE_SEGMENTS",
            &links["custom"]["reservedWords"],
        ),
    );

    let username = read("../common/config/username.json5");
    write(
        "username.rs",
        format!(
            "pub const USERNAME_MIN_LENGTH: usize = {};\npub const USERNAME_MAX_LENGTH: usize = {};\n",
            username["minLength"], username["maxLength"]
        ),
    );

    write(
        "domain_allowlist.rs",
        strings(
            "const DOMAIN_ALLOWLIST",
            &read("../common/config/domain-allowlist.json5"),
        ),
    );

    let tables = read("../server-shared/database/tables.json");
    write(
        "tables.rs",
        strings("const DROP_ORDER", &tables["drop"])
            + &strings("const CREATE_ORDER", &tables["create"]),
    );
}
