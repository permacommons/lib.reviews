#!/usr/bin/env bash
#
# This script is built to set up a lib.reviews development environment
# in a Codex VM environment with PostgreSQL pre-installed. It may also 
# be suitable for quick bootstrap in other Ubuntu-based environments,
# but its primary intended use is for Codex VMs at this point.

set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log 'Ensuring PostgreSQL service is running…'
if sudo service postgresql status >/dev/null 2>&1; then
  if sudo service postgresql status 2>/dev/null | grep -q 'down'; then
    log 'PostgreSQL service is down. Starting service…'
    sudo service postgresql start
  else
    log 'PostgreSQL service already running.'
  fi
else
  log 'Starting PostgreSQL service…'
  sudo service postgresql start
fi

log 'Creating libreviews_user role if needed…'
if [[ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='libreviews_user'")" != "1" ]]; then
  sudo -u postgres psql -c "CREATE ROLE libreviews_user LOGIN PASSWORD 'libreviews_password';"
else
  log 'Role libreviews_user already exists.'
fi

log 'Creating libreviews database if needed…'
if [[ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='libreviews'")" != "1" ]]; then
  sudo -u postgres createdb libreviews -O libreviews_user
else
  log 'Database libreviews already exists.'
fi

log 'Creating libreviews_test database if needed…'
if [[ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='libreviews_test'")" != "1" ]]; then
  sudo -u postgres createdb libreviews_test -O libreviews_user
else
  log 'Database libreviews_test already exists.'
fi

log 'Applying database grants and extensions…'
sudo -u postgres psql -f "$REPO_ROOT/dal/setup-db-grants.sql" >/dev/null

log 'Installing npm dependencies…'
npm install

log 'Building frontend assets…'
npm run build:frontend

log 'Initializing PostgreSQL migrations…'
node --import tsx/esm -e "await import('./db-postgres.ts').then(m => m.initializePostgreSQL()).then(dal => dal?.disconnect?.())"

log 'Environment setup complete.'
