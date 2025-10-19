# Dual Database Setup Guide

This guide helps you set up both RethinkDB and PostgreSQL for testing the migration.

## Prerequisites

### RethinkDB (existing)
- RethinkDB should already be installed and running
- Default configuration expects it on `localhost:28015`

### PostgreSQL (new)
- Install PostgreSQL 12+ 
- Create a database named `libreviews`
- Ensure PostgreSQL is running on `localhost:5432`

## Quick Setup

### 1. Install PostgreSQL (if not already installed)

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
```

**macOS (with Homebrew):**
```bash
brew install postgresql
brew services start postgresql
```

**Windows:**
Download from https://www.postgresql.org/download/windows/

### 2. Create Database and User

```bash
# Connect to PostgreSQL
psql postgres

# Create database and user
CREATE DATABASE libreviews;
CREATE USER libreviews_user WITH PASSWORD 'libreviews_password';
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
\q
```

Or use command line tools:
```bash
# Create user and database
createuser libreviews_user
createdb libreviews -O libreviews_user
```

### 3. Set Required Database Permissions

The libreviews_user needs specific permissions for the DAL to work properly:

```bash
# Connect to the libreviews database
psql libreviews

# Grant schema permissions (required for migrations and table creation)
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT CREATE ON SCHEMA public TO libreviews_user;

# Set password for the user (required for TCP connections)
ALTER USER libreviews_user WITH PASSWORD 'libreviews_password';
\q
```

**Important**: The DAL connects via TCP (localhost) rather than Unix sockets to avoid peer authentication issues.

### 4. Update Configuration

Edit `config/development.json5` to match your PostgreSQL setup:

```json5
{
  postgres: {
    host: "localhost",        // Use TCP connection (not Unix socket)
    port: 5432,
    database: "libreviews",
    user: "libreviews_user",
    password: "libreviews_password",  // Required for TCP auth
    max: 20
  },
  dualDatabaseMode: true
}
```

### 5. Install Dependencies

```bash
npm install
```

### 6. Test the Setup

```bash
# Test PostgreSQL connection and basic functionality
npm run test-postgres
```

## Expected Test Results

The PostgreSQL test suite will verify:

1. **Database Connection** - Should pass if PostgreSQL is configured correctly
2. **Schema Creation** - Tests create their own tables with proper isolation
3. **Model Functionality** - Tests exercise the full PostgreSQL DAL and models
4. **Query Builder** - Tests verify RethinkDB-compatible query patterns work

See `tests-postgres/README.md` for detailed information about the test setup and requirements.

## Troubleshooting

### PostgreSQL Connection Issues

**Error: "password authentication failed"**
- Check username/password in `config/development.json5`
- Verify user exists: `psql postgres -c "\\du"`

**Error: "database does not exist"**
- Create the database: `createdb libreviews`

**Error: "connection refused"**
- Check if PostgreSQL is running: `systemctl status postgresql`
- Start if needed: `systemctl start postgresql`

### RethinkDB Connection Issues

**Error: "connection refused"**
- Check if RethinkDB is running
- Verify it's listening on the correct port (28015)

### Permission Issues

**Error: "permission denied for schema public"**
- Grant schema permissions: `GRANT ALL ON SCHEMA public TO libreviews_user;`
- Grant create permissions: `GRANT CREATE ON SCHEMA public TO libreviews_user;`

**Error: "permission denied"**
- Ensure user has all database privileges: `GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;`
- Check database ownership with `\l` in psql

## Complete Setup Script

For convenience, here's the complete setup in one script:

```bash
# Create user and database
createuser libreviews_user
createdb libreviews -O libreviews_user

# Set up permissions
psql libreviews << EOF
ALTER USER libreviews_user WITH PASSWORD 'libreviews_password';
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT CREATE ON SCHEMA public TO libreviews_user;
EOF

# Test the connection
PGPASSWORD=libreviews_password psql -h localhost -U libreviews_user -d libreviews -c "SELECT 'Connection successful!' as status;"

# Install dependencies and test
npm install
npm run test-postgres
```

## Next Steps

Once both databases are connected:

1. The PostgreSQL schema will be automatically created via migrations
2. You can start testing individual model migrations
3. Compare data between RethinkDB and PostgreSQL implementations

### Running PostgreSQL Tests

The PostgreSQL test suite runs independently from RethinkDB tests and automatically
sets `LIBREVIEWS_SKIP_RETHINK=1`:

```bash
npm run test-postgres
```

This makes it safe to run on machines that only have PostgreSQL available. The test
harness in `tests-postgres/` provides comprehensive coverage of the PostgreSQL DAL
and models with proper test isolation.

For detailed information about test setup, database permissions, and troubleshooting,
see `tests-postgres/README.md`.

## Files Created for Dual Setup

- `config/development.json5` - Dual database configuration
- `db-dual.js` - Dual database initialization
- `models-postgres/` - Complete PostgreSQL model implementations
- `tests-postgres/` - PostgreSQL test suite with proper isolation
- `dal/` - Complete PostgreSQL DAL implementation
- `migrations/001_create_postgresql_schema.sql` - Database schema

## Safety Notes

- This setup runs both databases in parallel
- No data is automatically migrated between them
- The existing RethinkDB setup remains unchanged
- PostgreSQL is additive and can be safely removed
