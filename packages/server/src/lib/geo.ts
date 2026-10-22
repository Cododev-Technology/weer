import fs from "fs";
import { Reader, type CountryResponse } from "maxmind";

// The DB-IP country database, downloaded with yarn geo in server-shared (see geo/update.sh)
const GEO_PATH = new URL(
  "../../../server-shared/geo/dbip-country-lite.mmdb",
  import.meta.url
).pathname;

let reader: Reader<CountryResponse> | null = null;

try {
  reader = new Reader<CountryResponse>(fs.readFileSync(GEO_PATH));
} catch {
  console.warn(
    `[geo] No country database at ${GEO_PATH}, so every country shows as unknown. Run yarn geo in packages/server-shared.`
  );
}

// The country code of an IP address (like "DE"), or null if it's not known
export function countryOf(ip: string | null | undefined): string | null {
  if (!reader || !ip) return null;

  try {
    // An IPv4 address that came in over IPv6 looks like ::ffff:1.2.3.4
    return reader.get(ip.replace(/^::ffff:/i, ""))?.country?.iso_code ?? null;
  } catch {
    // Not an IP address
    return null;
  }
}
