use std::sync::LazyLock;

use regex::Regex;

// The checks of packages/common/src/validation.ts (@weer/common), which the front end runs
// on the same values before it sends them

pub fn is_valid_name(name: &str) -> bool {
    (3..=30).contains(&name.chars().count())
        && name.chars().all(|c| c.is_ascii_alphabetic() || c == ' ')
}

// The same pattern as the one of the front end, so both accept the same addresses
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$"#,
    )
    .unwrap()
});

pub fn is_valid_email(email: &str) -> bool {
    EMAIL.is_match(email)
}

pub fn is_valid_password(password: &str) -> bool {
    (8..=30).contains(&password.chars().count())
        && password.chars().any(|c| c.is_ascii_digit())
        && password.chars().any(|c| c.is_ascii_lowercase())
        && password.chars().any(|c| c.is_ascii_uppercase())
}

// Letters, digits, - and _ (CODE_CHARSET_REGEX)
fn has_code_charset(code: &str) -> bool {
    !code.is_empty()
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub const CUSTOM_CODE_MIN_LENGTH: usize = 7;
pub const AFFIX_CODE_MIN_LENGTH: usize = 1;
pub const CODE_MAX_LENGTH: usize = 80;

pub fn is_valid_custom_code(code: &str) -> bool {
    (CUSTOM_CODE_MIN_LENGTH..=CODE_MAX_LENGTH).contains(&code.chars().count())
        && has_code_charset(code)
}

pub fn is_valid_affix_code(code: &str) -> bool {
    (AFFIX_CODE_MIN_LENGTH..=CODE_MAX_LENGTH).contains(&code.chars().count())
        && has_code_charset(code)
}

pub const USERNAME_MIN_LENGTH: usize = 1;
pub const USERNAME_MAX_LENGTH: usize = 30;

pub fn is_valid_username(username: &str) -> bool {
    (USERNAME_MIN_LENGTH..=USERNAME_MAX_LENGTH).contains(&username.chars().count())
        && has_code_charset(username)
}
