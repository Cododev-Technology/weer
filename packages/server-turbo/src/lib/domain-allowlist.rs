use std::collections::HashSet;
use std::sync::LazyLock;

use url::Url;

// List of domains that we 100% trust. Links pointing to these will not be checked by our API safe link checker.
// Also, we will not show a secondary page to users upon redirects (The one that says "are you sure that you want to be redirected to this link?")
// We use a Set for O(1) lookups.
static ALLOWLISTED_DOMAINS: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| HashSet::from(DOMAIN_ALLOWLIST));

// (DOMAIN_ALLOWLIST, from packages/common/config/domain-allowlist.json5, written by build.rs)
include!(concat!(env!("OUT_DIR"), "/domain_allowlist.rs"));

pub fn is_allowlisted_domain(url: &str) -> bool {
    let hostname = match Url::parse(url) {
        Ok(url) => url.host_str().unwrap_or("").to_lowercase(),
        Err(_) => return false,
    };

    // Walk from the full hostname down to each shorter suffix (e.g. "a.b.example.com" ->
    // "b.example.com" -> "example.com" -> "com"), checking each against the set. Cost is
    // O(number of labels in the hostname), independent of how many domains are allowlisted.
    let labels: Vec<&str> = hostname.split('.').collect();
    for i in 0..labels.len() {
        if ALLOWLISTED_DOMAINS.contains(labels[i..].join(".").as_str()) {
            return true;
        }
    }

    false
}
