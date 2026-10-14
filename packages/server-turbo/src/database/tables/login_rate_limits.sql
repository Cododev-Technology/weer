-- Cooldown for the login endpoint, keyed by the email being logged into
CREATE TABLE IF NOT EXISTS login_rate_limits (
  email VARCHAR(200) PRIMARY KEY,
  burst_count INT NOT NULL DEFAULT 0,
  burst_reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
