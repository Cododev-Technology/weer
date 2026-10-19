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
  // Use the Redis cluster (REDIS_CLUSTER_NODES) instead of the single Redis (REDIS_URL), like
  // server-turbo does
  redisCluster: getOptionalEnv("REDIS_CLUSTER") === "true",
  // The Redis cluster (comma separated), which the seed flushes too
  redisClusterNodes: getOptionalEnv("REDIS_CLUSTER_NODES"),
  // In the cluster, how many streams the views are spread over, so they land on more than one node
  viewsStreamShards: Number(getOptionalEnv("VIEWS_STREAM_SHARDS")) || 48,
  // Save the links in Redis once they're visited, so the next visits skip the database
  linkCache: getOptionalEnv("LINK_CACHE") !== "false",
  // Show the warning page before redirecting to a domain that isn't on the allowlist
  redirectWarning: getOptionalEnv("REDIRECT_WARNING") !== "false",
  // Limit how many links, emails and logins a visitor or a user can make (see lib/rate-limit.ts)
  rateLimit: getOptionalEnv("RATE_LIMIT") !== "false",
  // Write a line to the info log for every request
  requestLog: getOptionalEnv("REQUEST_LOG") !== "false",
};
