// List of domains that we 100% trust. Links pointing to these will not be checked by our API safe link checker.
// Also, we will not show a secondary page to users upon redirects (The one that says "are you sure that you want to be redirected to this link?")
// We use a Set for O(1) lookups.
const ALLOWLISTED_DOMAINS = new Set([
  "instagram.com",
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "amazon.com",
  "google.com",
  "github.com",
]);

export function isAllowlistedDomain(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  // Walk from the full hostname down to each shorter suffix (e.g. "a.b.example.com" ->
  // "b.example.com" -> "example.com" -> "com"), checking each against the set. Cost is
  // O(number of labels in the hostname), independent of how many domains are allowlisted.
  const labels = hostname.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (ALLOWLISTED_DOMAINS.has(labels.slice(i).join("."))) return true;
  }

  return false;
}
