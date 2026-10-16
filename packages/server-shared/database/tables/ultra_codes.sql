-- These are the ultra short codes, 1-2 characters long only, case insensitive, no o or l to avoid confusion
-- They expire after LINKS.ultra.validFor of assignment
-- (LINKS object definition is in packages/server/src/lib/links.ts file)
create table if not exists ultra_codes (
  id SERIAL PRIMARY KEY,
  code varchar(2) UNIQUE NOT NULL, -- the ultra code itself
  url_id INT UNIQUE DEFAULT NULL,-- id from the urls table
  assigned_at timestamptz DEFAULT NULL,
  expires_at timestamptz DEFAULT NULL, -- should be LINKS.ultra.validFor after assigned_at
  CONSTRAINT fk_url FOREIGN KEY (url_id) REFERENCES urls(id) ON DELETE SET NULL
);