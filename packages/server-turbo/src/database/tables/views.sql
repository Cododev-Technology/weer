-- Each record represents a view of a shortened URL
CREATE TABLE IF NOT EXISTS views (
  id SERIAL PRIMARY KEY,
  url_id INT NOT NULL,
  
  ip_address INET,
  user_agent TEXT,
  referrer TEXT,
  visitor_hash CHAR(64),

  link_type link_type_enum, -- the type of the link when it was viewed
  via_qr BOOLEAN, -- if the link was accessed via QR code

  -- Optional, if we do IP geolocation:
  country VARCHAR(100),
  city VARCHAR(100),
  
  
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT fk_url FOREIGN KEY (url_id) REFERENCES urls(id) ON DELETE CASCADE,

  -- Ensure that if via_qr is true, link_type is NULL, and if via_qr is false, link_type is NOT NULL
  CONSTRAINT check_link_source 
    CHECK (
     (via_qr = TRUE AND link_type IS NULL) 
    OR 
     (via_qr = FALSE AND link_type IS NOT NULL)
    )
);
