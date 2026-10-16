use cpeak::crypto::base64url_encode;

// Static top-level route segments registered in router.rs. A "custom" code or
// a username occupying these would collide with a real route.
// (RESERVED_ROUTE_SEGMENTS, from custom.reservedWords in packages/common/config/links.json5,
// written by build.rs)
include!(concat!(env!("OUT_DIR"), "/reserved_route_segments.rs"));

// The properties of a type of link whose codes we generate ourselves
pub struct Link {
    pub characters: &'static str,
    pub max_length: usize,
    pub min_length: usize,

    pub requires_auth: bool,
    pub conversions: &'static [(&'static str, &'static str)],
    pub valid_for: Option<i64>,
}

// The properties of a type of link whose codes the user picks
pub struct Picked {
    pub min_length: usize,
    pub max_length: usize,
    pub requires_auth: bool,
    pub reserved_words: &'static [&'static str],
}

pub struct Qr {
    // (the function that writes the random bytes as text)
    pub character_encoding: fn(Vec<u8>) -> String,
    pub length: usize,
    pub size: usize,
}

pub struct Links {
    pub classic: Link,
    pub ultra: Link,
    pub digit: Link,
    pub custom: Picked,
    pub affix: Picked,
    pub qr: Qr,
}

/* @TODO maybe send this data to client for the customization model to show the data dynamically */
// This should be our single source of truth for link types and their properties
// (LINKS, from packages/common/config/links.json5, written by build.rs)
include!(concat!(env!("OUT_DIR"), "/links.rs"));
