CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now();
RETURN NEW;
END;
$$ language 'plpgsql';
DROP TRIGGER IF EXISTS update_updated_at ON users;

-- Triggers to updated the updated_at column for users table
CREATE TRIGGER update_updated_at BEFORE
UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

-- Triggers to updated the updated_at column for urls table
CREATE TRIGGER update_updated_at BEFORE
UPDATE ON urls FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();