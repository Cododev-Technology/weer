SET timezone TO 'GMT';
-- CREATE USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  google_id VARCHAR(200),
  email VARCHAR(200),
  name VARCHAR(200),
  password VARCHAR(200),
  verified BOOLEAN,

  link_count INTEGER DEFAULT 0, -- number of URLs user has shortened. Includes deleted links and customization.

  link_credits INTEGER NOT NULL DEFAULT 100, -- lifetime link creation/edit budget. Can be increased.

  token_code VARCHAR(200),
  token_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  UNIQUE (email)
);