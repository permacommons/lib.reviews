# PostgreSQL Setup Guide

This document walks through setting up lib.reviews with PostgreSQL only. It captures the exact steps used to bring up a fresh environment and run the PostgreSQL test suite (`npm run test-postgres`) without relying on RethinkDB.

> **Heads up:** The PostgreSQL DAL expects a dedicated user with full privileges on a primary database (`libreviews`) and on a single isolated test database (`libreviews_test`). The test harness provisions schemas on the fly, but it needs permission to create tables, sequences, and the `pgcrypto` extension in each database.

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

## 4. Create the isolated PostgreSQL test database

The PostgreSQL AVA harness uses a single test database. Create it before running tests:

```bash
sudo -u postgres createdb libreviews_test -O libreviews_user
```

Re-running the command is safe; `createdb` will report an error if the database already exists.

## 5. Grant permissions and enable extensions

Grant the application role full control over the test database and enable the `pgcrypto` extension that the migrations rely on. A helper script is available inside the repository:

```bash
PGUSER=postgres psql -f dal/setup-test-db-grants.sql
```

If your environment enforces peer authentication for the `postgres` role (the
default on many Linux distributions), run the helper via `sudo` instead:

```bash
sudo -u postgres psql -f dal/setup-test-db-grants.sql
```

The script issues the following changes for the `libreviews_test` database:

- grants `libreviews_user` all privileges on the database and `public` schema,
- grants privileges on all existing tables and sequences,
- sets default privileges so future tables/sequences remain accessible,
- installs the `pgcrypto` extension (needed for UUID generation).

If you prefer to apply the grants manually, mirror the statements from `dal/setup-test-db-grants.sql` in the database.

## 6. Run the application to apply migrations

When lib.reviews starts against PostgreSQL it automatically runs any pending migrations and records them for future upgrades. Launch the server once (development mode is fine) to initialize the primary database:

```bash
npm run start-dev
```

You can leave the server running for development, or stop it once it finishes booting (Ctrl+C) if you only needed to seed the schema. Avoid manually applying `migrations/001_initial_schema.sql`; running the app keeps the migration history consistent.

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

The runner compiles the Vite bundle on first run (creating `build/vite/.vite/manifest.json`) and then executes the AVA suite under `tests/`.

## 9. Troubleshooting checklist

- **Connection failures:** verify PostgreSQL is running and reachable on `localhost:5432`.
- **Permission errors:** re-run `psql -f dal/setup-test-db-grants.sql` to restore grants and default privileges.
- **Missing extensions:** ensure the `pgcrypto` extension exists in the `libreviews_test` database.
- **Asset build issues:** delete `build/vite` and let `npm run test-postgres` rebuild the bundle.

Following the steps above provides a functioning PostgreSQL-only environment capable of running the lib.reviews PostgreSQL test suite.

## 10. Notes

- The setup has been verified with PostgreSQL 16.10 on Ubuntu 24.04.
- During the `npm install` step, you may see deprecation warnings for packages like `session-rethinkdb`, `csurf`, and `elasticsearch`. These are expected as the project is in the process of migrating away from RethinkDB.
- When running the test suite with `npm run test-postgres`, you may see multiple `DeprecationWarning: The util._extend API is deprecated` messages. These warnings are harmless and do not affect the outcome of the tests.
- To clean up the old test databases, run the following commands:
  ```bash
  for i in $(seq 1 6); do sudo -u postgres dropdb libreviews_test_$i; done
  ```
