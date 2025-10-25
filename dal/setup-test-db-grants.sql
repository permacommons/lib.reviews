-- PostgreSQL test database grants setup
-- This script sets up permissions for the new single test database

-- Grant database-level permissions to libreviews_user
GRANT ALL PRIVILEGES ON DATABASE libreviews_test TO libreviews_user;

-- Connect to the database and grant schema permissions
\c libreviews_test;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
-- Grant permissions on future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
