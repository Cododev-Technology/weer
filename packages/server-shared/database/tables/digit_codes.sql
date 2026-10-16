-- These are the digit short codes, 3-5 digits long only.
-- They expire after LINKS.digit.validFor of assignment
-- (LINKS object definition is in packages/server/src/lib/links.ts file)
create table if not exists digit_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(5) UNIQUE NOT NULL, -- the digit code itself
  url_id INT UNIQUE DEFAULT NULL,-- id from the urls table
  code_length INT, -- either 3, 4 or 5
  assigned_at timestamptz DEFAULT NULL,
  expires_at timestamptz DEFAULT NULL,
  CONSTRAINT fk_url FOREIGN KEY (url_id) REFERENCES urls(id) ON DELETE CASCADE
);

