import keys from "../config/keys.js";
import { log } from "cpeak";

const WEB_RISK_URL = "https://webrisk.googleapis.com/v1/uris:search";
const THREAT_TYPES = [
  "MALWARE",
  "SOCIAL_ENGINEERING",
  "UNWANTED_SOFTWARE",
  "SOCIAL_ENGINEERING_EXTENDED_COVERAGE",
];

interface WebRiskResponse {
  threat?: { threatTypes?: string[] };
}

export async function isUrlMalicious(url: string): Promise<boolean> {
  // If this is not set as an environment variable, skip this API altogether.
  if (!keys.webRiskApiKey) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const params = new URLSearchParams({ key: keys.webRiskApiKey, uri: url });
    for (const t of THREAT_TYPES) params.append("threatTypes", t);

    const res = await fetch(`${WEB_RISK_URL}?${params.toString()}`, {
      signal: controller.signal,
    });

    const data = (await res.json()) as WebRiskResponse;
    log(`[web-risk] response for ${url} ${JSON.stringify(data)}`);

    // Not a 2xx (quota exceeded, bad key...): log it, it is an error even though the request worked
    if (!res.ok) {
      log(new Error(`[web-risk] ${res.status} for ${url}: ${JSON.stringify(data)}`));
      return false;
    }

    return Boolean(data.threat);
  } catch (error) {
    // API failure: a Web Risk outage or timeout should not block link creation.
    log(error as Error);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
