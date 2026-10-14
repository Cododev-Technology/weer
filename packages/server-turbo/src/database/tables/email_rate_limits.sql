-- Cooldown for code-sending endpoints (signup, forgot-password, change-email)
CREATE TABLE IF NOT EXISTS email_rate_limits (
  email VARCHAR(200) PRIMARY KEY,
  burst_count INT NOT NULL DEFAULT 0,
  burst_reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
