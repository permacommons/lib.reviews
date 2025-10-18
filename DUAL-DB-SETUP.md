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
npm run test-dual-db
```

## Expected Test Results

The test script will check:

1. **RethinkDB Connection** - Should pass if RethinkDB is running
2. **PostgreSQL Connection** - Should pass if PostgreSQL is configured correctly
3. **PostgreSQL User Model** - May fail initially (tables not created yet)

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
npm run test-dual-db
```

## Next Steps

Once both databases are connected:

1. The PostgreSQL schema will be automatically created via migrations
2. You can start testing individual model migrations
3. Compare data between RethinkDB and PostgreSQL implementations

## Files Created for Dual Setup

- `config/development.json5` - Dual database configuration
- `db-dual.js` - Dual database initialization
- `models-postgres/user.js` - Test PostgreSQL User model
- `test-dual-db.js` - Test script for both databases
- `dal/` - Complete PostgreSQL DAL implementation
- `migrations/001_create_postgresql_schema.sql` - Database schema

## Safety Notes

- This setup runs both databases in parallel
- No data is automatically migrated between them
- The existing RethinkDB setup remains unchanged
- PostgreSQL is additive and can be safely removed