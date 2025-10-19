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

### 3. Apply Schema and Set Permissions

Apply the PostgreSQL schema and configure permissions:

```bash
# Apply the initial schema migration
psql libreviews -f migrations/001_initial_schema.sql

# Grant permissions to libreviews_user
psql libreviews << EOF
# Grant schema permissions (required for migrations and table operations)
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT CREATE ON SCHEMA public TO libreviews_user;

# Grant permissions on all tables and sequences
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;

# Set password for the user (required for TCP connections)
ALTER USER libreviews_user WITH PASSWORD 'libreviews_password';
EOF
```

**Important**: The DAL connects via TCP (localhost) rather than Unix sockets to avoid peer authentication issues.

### 4. Migrate Data from RethinkDB to PostgreSQL

Once the schema is in place, migrate data from RethinkDB:

```bash
# Ensure RethinkDB is running with your data
# Then run the migration tool
node migrations/migrate-rethinkdb-to-postgres.js --verbose
```

The migration tool will:
- Connect to both RethinkDB and PostgreSQL
- Migrate all 15 tables (users, teams, things, reviews, files, etc.)
- Transform data to PostgreSQL format (camelCase → snake_case, etc.)
- Validate data integrity after migration
- Generate a detailed migration report at `migration-report.json`

Expected output:
```
✓ Migration completed successfully
Duration: ~15 seconds
Tables processed: 15
Records migrated: 7000+
Records skipped: 0-5 (due to referential integrity)
Errors: 0
```

**What gets migrated:**
- All user accounts and metadata
- Teams and team memberships
- Things (items being reviewed) and their metadata
- Reviews with multilingual content
- Files and media attachments
- Blog posts
- Invite links
- All many-to-many relationships

**Data transformations:**
- Field names converted from camelCase to snake_case
- Multilingual strings preserved as JSONB
- Metadata fields grouped in JSONB for things
- Revision tracking fields maintained
- Foreign key relationships validated

### 5. Update Configuration

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

### 6. Install Dependencies

```bash
npm install
```

### 7. Test the Setup

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
# Step 1: Create user and database
createuser libreviews_user
createdb libreviews

# Step 2: Apply schema migration
psql libreviews -f migrations/001_initial_schema.sql

# Step 3: Set up permissions
psql libreviews << EOF
ALTER USER libreviews_user WITH PASSWORD 'libreviews_password';
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT CREATE ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
EOF

# Step 4: Test the connection
PGPASSWORD=libreviews_password psql -h localhost -U libreviews_user -d libreviews -c "SELECT 'Connection successful!' as status;"

# Step 5: Install dependencies
npm install

# Step 6: Migrate data from RethinkDB (ensure RethinkDB is running first!)
node migrations/migrate-rethinkdb-to-postgres.js --verbose

# Step 7: Run tests
npm run test-postgres
```

**Note**: Make sure RethinkDB is running with your data before executing step 6.

## Next Steps

Once both databases are connected and data is migrated:

1. The PostgreSQL schema is applied via `migrations/001_initial_schema.sql`
2. Data is migrated from RethinkDB using `migrations/migrate-rethinkdb-to-postgres.js`
3. You can compare data between RethinkDB and PostgreSQL implementations
4. Run tests to verify both database implementations work correctly

### Verifying the Migration

Check migrated data:

```bash
# Connect to PostgreSQL
psql libreviews

# Check table counts
SELECT 'users' as table, count(*) FROM users
UNION ALL SELECT 'teams', count(*) FROM teams
UNION ALL SELECT 'things', count(*) FROM things
UNION ALL SELECT 'reviews', count(*) FROM reviews
UNION ALL SELECT 'files', count(*) FROM files;

# Review the migration report
cat migration-report.json
```

### Re-running the Migration

If you need to re-run the migration:

```bash
# Drop and recreate the database
dropdb libreviews
createdb libreviews

# Re-apply schema and permissions
psql libreviews -f migrations/001_initial_schema.sql
psql libreviews << EOF
GRANT ALL PRIVILEGES ON DATABASE libreviews TO libreviews_user;
GRANT ALL ON SCHEMA public TO libreviews_user;
GRANT CREATE ON SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO libreviews_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO libreviews_user;
EOF

# Re-run migration
node migrations/migrate-rethinkdb-to-postgres.js --verbose
```

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
- `migrations/001_initial_schema.sql` - Consolidated database schema
- `migrations/migrate-rethinkdb-to-postgres.js` - Data migration tool
- `migrations/lib/migration-validator.js` - Migration validation logic
- `migrations/lib/data-transformer.js` - Data transformation utilities
- `migrations/lib/migration-reporter.js` - Migration reporting

## Migration Tool Options

The migration tool supports several command-line options:

```bash
# Run with verbose logging
node migrations/migrate-rethinkdb-to-postgres.js --verbose

# Dry run (show what would be migrated without changes)
node migrations/migrate-rethinkdb-to-postgres.js --dry-run

# Migrate only a specific table
node migrations/migrate-rethinkdb-to-postgres.js --table=users

# Validate data only (no migration)
node migrations/migrate-rethinkdb-to-postgres.js --validate-only

# Custom batch size
node migrations/migrate-rethinkdb-to-postgres.js --batch-size=500
```

## Safety Notes

- This setup runs both databases in parallel
- Data is migrated via the migration tool, not automatically
- The migration tool validates all data and generates reports
- The existing RethinkDB setup remains unchanged during migration
- PostgreSQL is additive and can be safely removed
- All migrations can be re-run by dropping and recreating the database
