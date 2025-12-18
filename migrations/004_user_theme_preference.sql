-- Add theme preference column to users table

ALTER TABLE users
  ADD COLUMN theme_preference VARCHAR(10)
  CHECK (theme_preference IN ('light', 'dark', 'system'));

COMMENT ON COLUMN users.theme_preference IS 'User preference for light/dark/system theme. NULL means no preference set (fall back to cookie or system default).';
