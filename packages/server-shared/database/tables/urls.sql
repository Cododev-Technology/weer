-- Change packages/common/src/types.ts as well if modifying this enum
CREATE TYPE link_type_enum AS ENUM (
  'classic',

  -- if a user has chosen a custom code but not on their username [like weer.pro/whatever] 
  'custom',

  -- If a user has chosen a custom code to be on their username [like weer.pro/joe/whatever]
  'affix', 

  -- If a logged in user has selected the ultra code option (1-2 characters, expires in 30 minutes)
  'ultra',

  -- If a user has selected the digit code option (3-5 digits, expires in 2 hours)
  'digit'
);

-- URLS TABLE
CREATE TABLE IF NOT EXISTS urls (
  id SERIAL PRIMARY KEY,
  real_url VARCHAR(2200) NOT NULL, -- original URL
  shortened_url_id VARCHAR(80) DEFAULT NULL, -- short code for the shortened URL that users see
  qr_code_id VARCHAR(10) DEFAULT NULL UNIQUE, -- short code for QR code only

  -- Owner can be a registered user OR an anonymous session
  user_id INT,
  session_id INT,

  link_type link_type_enum NOT NULL DEFAULT 'classic',

  -- Esp. needed for non-logged in users to prevent spamming and impose rate limits
  ip_address INET,

  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  CONSTRAINT chk_owner CHECK (
    (
      user_id IS NOT NULL
      AND session_id IS NULL
    )
    OR (
      user_id IS NULL
      AND session_id IS NOT NULL
    )
  )
);

-- Hash Index for quick lookup of shortened URLs.
-- Note: Why hash indexes? Since the codes are random, creating a b-tree index will make writes slightly slower (still will make reads much faster).
--       The difference in write performance will become pronounced as the number of records grows (billions of records).
--       But with hash indexes, the write performance will remain consistent regardless of the number of records. Tradeoff is that we can't do range queries, but we don't need that for shortened URLs.
CREATE INDEX idx_urls_shortened_url_id ON urls USING HASH (shortened_url_id);


-- Ensure a record cannot have the same shortened_url_id more than once if it's not on a username
CREATE UNIQUE INDEX unique_global_url_code
  ON urls (shortened_url_id)
  WHERE link_type IN ('classic'::link_type_enum, 'custom'::link_type_enum);


-- Ensure a user cannot have the same shortened_url_id more than once if it's on their username
CREATE UNIQUE INDEX unique_per_user_custom_code
  ON urls (user_id, shortened_url_id)
  WHERE link_type = 'affix'::link_type_enum;