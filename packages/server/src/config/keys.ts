const getEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    console.error(`Missing environment variable: ${key}`);
  }
  return value || "";
};

// For the settings that have a default, so leaving them out is fine
const getOptionalEnv = (key: string): string | undefined => {
  return process.env[key] || undefined;
};

export default {
  domain: getEnv("DOMAIN"),
  googleClientID: getEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: getEnv("GOOGLE_CLIENT_SECRET"),
  cookieKey: getEnv("COOKIE_KEY"),
  tokenSecret: getEnv("TOKEN_SECRET"),
  webRiskApiKey: getEnv("WEB_RISK_API_KEY"),
  sesRegion: getEnv("AWS_REGION"),
  sesFromEmail: getEnv("SES_FROM_EMAIL"),
  // Postgres
  dbUser: getEnv("DB_USER"),
  dbHost: getEnv("DB_HOST"),
  dbDatabase: getEnv("DB_DATABASE"),
  dbPassword: getEnv("DB_PASSWORD"),
  dbPort: Number(getEnv("DB_PORT")),
  dbPoolSize: Number(getOptionalEnv("DB_POOL_SIZE")) || 10,
  // Redis
  redisUrl: getEnv("REDIS_URL"),
  redisEnabled: getEnv("REDIS") === "true",
  // Show the warning page before redirecting to a domain that isn't on the allowlist
  redirectWarning: getOptionalEnv("REDIRECT_WARNING") !== "false",
  // Limit how many links, emails and logins a visitor or a user can make (see lib/rate-limit.ts)
  rateLimit: getOptionalEnv("RATE_LIMIT") !== "false",
  // Write a line to the info log for every request
  requestLog: getOptionalEnv("REQUEST_LOG") !== "false",
};
