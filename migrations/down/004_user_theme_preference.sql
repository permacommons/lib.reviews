-- Remove theme preference column from users table

ALTER TABLE users
  DROP COLUMN IF EXISTS theme_preference;
