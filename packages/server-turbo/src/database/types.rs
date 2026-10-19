use std::net::IpAddr;

use chrono::{DateTime, Utc};
use cpeak::Value;
use sqlx::FromRow;

// The same as LinkType in @weer/common (packages/common/src/types.ts): "classic", "custom",
// "affix" (custom on username), "ultra", "digit" or "qr". All of them but "qr" are also the
// values of link_type_enum in the database.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, sqlx::Type)]
#[sqlx(type_name = "link_type_enum", rename_all = "lowercase")]
pub enum LinkType {
    #[default]
    Classic,
    Custom,
    Affix,
    Ultra,
    Digit,
    Qr,
}

impl LinkType {
    // The link type as text, the way it is in JSON and in a URL
    pub fn as_str(self) -> &'static str {
        match self {
            LinkType::Classic => "classic",
            LinkType::Custom => "custom",
            LinkType::Affix => "affix",
            LinkType::Ultra => "ultra",
            LinkType::Digit => "digit",
            LinkType::Qr => "qr",
        }
    }

    // And the other way around. None for a text that isn't a link type.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "classic" => LinkType::Classic,
            "custom" => LinkType::Custom,
            "affix" => LinkType::Affix,
            "ultra" => LinkType::Ultra,
            "digit" => LinkType::Digit,
            "qr" => LinkType::Qr,
            _ => return None,
        })
    }
}

// In TypeScript, `DB.find<IUrl>(...)` only says what a row looks like. Here the row really
// becomes an IUrl. A column that wasn't selected gets the default value of its type (None, 0,
// "", false), and a column that can be NULL in the database is an Option.
//
// Every date column is a timestamptz (a moment in time, what a Date is in JavaScript).

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IUser {
    pub id: i32,
    pub google_id: Option<String>,
    pub username: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub password: Option<String>,
    pub verified: Option<bool>,
    pub link_credits: Option<i32>,
    pub token_code: Option<String>,
    pub token_date: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    // Not a column. On req.user, the id of the token of a user who logged in with their email
    // and password (req.user.tokenId in the Node.js version).
    #[sqlx(skip)]
    pub token_id: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct IRateLimit {
    pub ip_address: IpAddr,
    pub burst_count: i32,
    pub burst_reset_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct IEmailRateLimit {
    pub email: String,
    pub burst_count: i32,
    pub burst_reset_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ILoginRateLimit {
    pub email: String,
    pub burst_count: i32,
    pub burst_reset_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IToken {
    pub id: String,
    pub user_id: i32,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IEmailCode {
    pub id: i32,
    pub email: String,
    pub code: i32,
    pub attempts: i32,
    pub expires_at: DateTime<Utc>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IPayment {
    pub id: i32,
    pub paddle_id: String,
    pub transaction_id: String,
    pub user_id: i32,
    pub credits: i32,
    pub amount: i64,
    pub currency: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IUsername {
    pub id: i32,
    pub user_id: Option<i32>,
    pub username: String,
    pub active: Option<bool>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IUrl {
    pub id: i32,
    pub real_url: String,
    pub shortened_url_id: Option<String>,
    pub qr_code_id: Option<String>,
    pub user_id: Option<i32>,
    pub session_id: Option<i32>,
    pub link_type: LinkType,
    pub updated_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IUltraCode {
    pub id: i32,
    pub code: String,
    pub url_id: Option<i32>,
    pub expires_at: Option<DateTime<Utc>>,
    pub assigned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IDigitCode {
    pub id: i32,
    pub code: String,
    pub code_length: Option<i32>,
    pub url_id: Option<i32>,
    pub expires_at: Option<DateTime<Utc>>,
    pub assigned_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct IView {
    pub id: i64,
    pub url_id: i32,
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    pub link_type: Option<LinkType>,
    pub via_qr: Option<bool>,
    pub ip_address: Option<IpAddr>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub visitor_hash: Option<Vec<u8>>,
    pub created_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, FromRow)]
#[sqlx(default)]
pub struct ISession {
    pub id: i32,
    pub session_token: String,
    pub data: Option<Value>,
    pub created_at: Option<DateTime<Utc>>,
    pub last_active: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
}
