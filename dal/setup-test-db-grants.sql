-- PostgreSQL test database grants setup
-- This script sets up permissions for the existing test databases

-- Grant database-level permissions to libreviews_user
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_1 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_2 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_3 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_4 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_5 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_6 TO libreviews_user;

-- Connect to each database and grant schema permissions
\c libreviews_test_1;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
-- Grant permissions on future tables/sequences
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_2;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_3;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_4;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_5;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_6;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO libreviews_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO libreviews_user;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
