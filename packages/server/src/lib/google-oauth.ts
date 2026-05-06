import keys from "../config/keys.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: keys.googleClientID,
    redirect_uri: `${keys.domain}/auth/google/callback`,
    response_type: "code",
    scope: "profile email",
    access_type: "online",
  });
  return `${AUTH_URL}?${params}`;
}

export interface GoogleProfile {
  sub: string;
  name: string;
  email: string;
}

export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: keys.googleClientID,
      client_secret: keys.googleClientSecret,
      redirect_uri: `${keys.domain}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json() as { access_token: string; error?: string };
  if (tokens.error) throw new Error(`Google token error: ${tokens.error}`);

  const userRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  return userRes.json() as Promise<GoogleProfile>;
}
