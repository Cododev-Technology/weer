-- A user can have up to 4 usernames, only one is active and the rest expire in 30 days
CREATE TABLE IF NOT EXISTS usernames (
  id SERIAL PRIMARY KEY,
  username VARCHAR(200) NOT NULL,
  user_id INT,
  active BOOLEAN, -- only one active per user_id

  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ DEFAULT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (username)
);


-- Ensure only one active username per user
CREATE UNIQUE INDEX one_active_username_limit 
ON usernames (user_id) 
WHERE (active = true);