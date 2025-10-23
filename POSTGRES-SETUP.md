# PostgreSQL Setup Guide

This document walks through setting up lib.reviews with PostgreSQL only. It captures the exact steps used to bring up a fresh environment and run the PostgreSQL test suite (`npm run test-postgres`) without relying on RethinkDB.

> **Heads up:** The PostgreSQL DAL expects a dedicated user with full privileges on a primary database (`libreviews`) and on six isolated test databases (`libreviews_test_1` … `_6`). The test harness provisions schemas on the fly, but it needs permission to create tables, sequences, and the `pgcrypto` extension in each database.

## 1. Install PostgreSQL 12 or newer

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
```

### macOS (Homebrew)
```bash
brew install postgresql
brew services start postgresql
```

### Windows
Download and install PostgreSQL from <https://www.postgresql.org/download/windows/>. Make sure the server is running before continuing.

## 2. Ensure the PostgreSQL server is running

On Linux systems the service is managed by `systemd`:
```bash
sudo service postgresql start
```

On macOS and Windows the installers usually start PostgreSQL automatically. If needed, use `brew services list` (macOS) or the "pgAdmin" service manager (Windows) to confirm it is running.

## 3. Create the application role and primary database

```bash
# Open a psql session as the postgres superuser
sudo -u postgres psql

-- Create the login role (skip if it already exists)
CREATE ROLE libreviews_user LOGIN PASSWORD 'libreviews_password';

-- Create the primary application database
CREATE DATABASE libreviews OWNER libreviews_user;
\q
```

If you prefer command-line helpers:
```bash
sudo -u postgres createuser --login --pwprompt libreviews_user
sudo -u postgres createdb libreviews -O libreviews_user
```

## 4. Create the isolated PostgreSQL test databases

The PostgreSQL AVA harness uses up to six workers, each mapped to its own database. Create them all before running tests:

```bash
sudo -u postgres createdb libreviews_test_1 -O libreviews_user
sudo -u postgres createdb libreviews_test_2 -O libreviews_user
sudo -u postgres createdb libreviews_test_3 -O libreviews_user
sudo -u postgres createdb libreviews_test_4 -O libreviews_user
sudo -u postgres createdb libreviews_test_5 -O libreviews_user
sudo -u postgres createdb libreviews_test_6 -O libreviews_user
```

Re-running the command is safe; `createdb` will report an error if the database already exists.

## 5. Grant permissions and enable extensions

Grant the application role full control over each test database and enable the `pgcrypto` extension that the migrations rely on. A helper script is available inside the repository:

```bash
PGUSER=postgres psql -f dal/setup-test-db-grants.sql
```

The script issues the following changes for every `libreviews_test_*` database:

- grants `libreviews_user` all privileges on the database and `public` schema,
- grants privileges on all existing tables and sequences,
- sets default privileges so future tables/sequences remain accessible,
- installs the `pgcrypto` extension (needed for UUID generation).

If you prefer to apply the grants manually, mirror the statements from `dal/setup-test-db-grants.sql` in each database.

## 6. (Optional) Apply the base schema to the primary database

If you want to run the application against PostgreSQL, load the initial schema:

```bash
PGPASSWORD=libreviews_password psql -h localhost -U libreviews_user -d libreviews -f migrations/001_initial_schema.sql
```

The PostgreSQL test harness runs the migrations automatically inside isolated schemas, so this step is not required for `npm run test-postgres`.

## 7. Install Node.js dependencies

From the repository root run:
```bash
npm install
```

The prepare step runs `snyk-protect`; in offline environments it may emit `ENETUNREACH` warnings, but the installation still completes.

## 8. Run the PostgreSQL test suite

```bash
npm run test-postgres
```

The runner compiles the Vite bundle on first run (creating `build/vite/.vite/manifest.json`) and then executes the AVA suite under `tests-postgres/`. The command sets `LIBREVIEWS_SKIP_RETHINK=1`, so the tests never attempt a RethinkDB connection.

## 9. Troubleshooting checklist

- **Connection failures:** verify PostgreSQL is running and reachable on `localhost:5432`.
- **Permission errors:** re-run `psql -f dal/setup-test-db-grants.sql` to restore grants and default privileges.
- **Missing extensions:** ensure the `pgcrypto` extension exists in every `libreviews_test_*` database.
- **Asset build issues:** delete `build/vite` and let `npm run test-postgres` rebuild the bundle.

Following the steps above provides a functioning PostgreSQL-only environment capable of running the lib.reviews PostgreSQL test suite.
