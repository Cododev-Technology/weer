use aws_config::{BehaviorVersion, Region};
use aws_sdk_ses::error::DisplayErrorContext;
use aws_sdk_ses::types::{Body, Content, Destination, Message};
use aws_smithy_http_client::{Builder, tls};
use cpeak::{CpeakError, Value};

use crate::config::keys::KEYS;

const TEMPLATES_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../server-shared/email-templates"
);

pub enum Html<'a> {
    Raw(String),
    Template {
        html_file: &'a str,
        template_data: Value,
    },
}

// Sends an HTML email via SES. Pass a raw HTML string or a template from '../server-shared/email-templates', which
// is rendered with cpeak's render::string.
pub async fn send_email(to: &str, subject: &str, html: Html<'_>) -> Result<(), CpeakError> {
    if std::env::var("SKIP_EMAIL").as_deref() == Ok("true") {
        return Ok(());
    }

    let html_str = match html {
        Html::Raw(html) => html,
        Html::Template {
            html_file,
            template_data,
        } => {
            cpeak::render::string(&format!("{TEMPLATES_DIR}/{html_file}.html"), template_data)
                .await?
        }
    };

    let failed = |error: &dyn std::fmt::Display| CpeakError::other(format!("SES: {error}"));

    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(KEYS.ses_region.clone()))
        .http_client(
            Builder::new()
                .tls_provider(tls::Provider::Rustls(
                    tls::rustls_provider::CryptoMode::Ring,
                ))
                .build_https(),
        )
        .load()
        .await;
    let ses = aws_sdk_ses::Client::new(&config);

    let message = Message::builder()
        .subject(
            Content::builder()
                .data(subject)
                .build()
                .map_err(|error| failed(&error))?,
        )
        .body(
            Body::builder()
                .html(
                    Content::builder()
                        .data(html_str)
                        .build()
                        .map_err(|error| failed(&error))?,
                )
                .build(),
        )
        .build();

    ses.send_email()
        .source(&KEYS.ses_from_email)
        .destination(Destination::builder().to_addresses(to).build())
        .message(message)
        .send()
        .await
        .map_err(|error| failed(&DisplayErrorContext(&error)))?;
    Ok(())
}
