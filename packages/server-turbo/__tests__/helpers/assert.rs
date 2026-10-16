use chrono::DateTime;
use server_turbo::lib::util::to_iso_string;

// What assert.match(text, /^[a-z0-9]{6}$/) is in the tests of the Node.js version: the text is
// this many characters long, and all of them are ones of the set
#[track_caller]
pub fn assert_made_of(text: &str, length: usize, set: impl Fn(char) -> bool) {
    assert!(
        text.chars().count() == length && text.chars().all(set),
        "{text:?} is not {length} characters of the set"
    );
}

// new Date(text).getTime(): the moment of a date like 2026-01-15T10:20:30.123Z, in milliseconds
#[track_caller]
pub fn time(date: &str) -> i64 {
    DateTime::parse_from_rfc3339(date)
        .unwrap_or_else(|error| panic!("{date:?} is not a date: {error}"))
        .timestamp_millis()
}

// A date the way JavaScript writes it in JSON, like 2026-01-15T10:20:30.123Z
#[track_caller]
pub fn assert_iso_date(date: &str) {
    let parsed = DateTime::parse_from_rfc3339(date)
        .unwrap_or_else(|error| panic!("{date:?} is not a date: {error}"));
    assert_eq!(to_iso_string(parsed.to_utc()), date);
}
