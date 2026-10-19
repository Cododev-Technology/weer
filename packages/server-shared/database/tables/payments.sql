-- Credit purchases through Paddle, and their refunds and chargebacks
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  paddle_id TEXT NOT NULL UNIQUE, -- txn_... for a purchase, adj_... for a refund or chargeback
  transaction_id TEXT NOT NULL, -- the purchase's txn_...
  user_id INT NOT NULL,
  credits INTEGER NOT NULL, -- negative for a refund or chargeback
  amount BIGINT NOT NULL, -- tax included, in cents
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments (transaction_id);
