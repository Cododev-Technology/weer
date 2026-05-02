const getEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined) {
    console.error(`Missing environment variable: ${key}`);
  }
  return value || "";
};

export default {
  domain: getEnv("DOMAIN"),
  googleClientID: getEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: getEnv("GOOGLE_CLIENT_SECRET"),
  cookieKey: getEnv("COOKIE_KEY"),
  // Postgres
  dbUser: getEnv("DB_USER"),
  dbHost: getEnv("DB_HOST"),
  dbDatabase: getEnv("DB_DATABASE"),
  dbPassword: getEnv("DB_PASSWORD"),
  dbPort: Number(getEnv("DB_PORT")),
  // Redis
  redisUrl: getEnv("REDIS_URL"),
  redisEnabled: getEnv("REDIS") === "true",
};
