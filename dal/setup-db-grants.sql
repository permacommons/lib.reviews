-- PostgreSQL database grants setup
-- This script sets up permissions and required extensions for both the primary
-- libreviews database and the isolated libreviews_test database.

-- Grant database-level permissions to libreviews_user
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test TO libreviews_user;

-- Configure the primary application database
\c libreviews;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Configure the test database (used by the AVA harness)
\c libreviews_test;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
-- Grant permissions on future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
