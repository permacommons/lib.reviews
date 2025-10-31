# Contributing to lib.reviews

*Please also see the [code of conduct](https://github.com/permacommons/lib.reviews/blob/master/CODE_OF_CONDUCT.md).*

Thanks for taking a look! If you just want to write reviews, please see the [instructions for getting an account](https://lib.reviews/register). For technical/design contributions, read on.

We welcome contributions to [any of our open issues](https://github.com/permacommons/lib.reviews/issues), as well as new ideas. Issues tagged as "[good for new contributors](https://github.com/permacommons/lib.reviews/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+for+new+contributors%22)" don't require in-depth knowledge of the whole codebase. We're happy to set aside time for personal coaching in the codebase (e.g., via video-conference/screen-sharing). Ping `Eloquence` on **#lib.reviews** on [libera.chat](https://libera.chat/) to get started.

## Quick Start

1. **Prerequisites:** Node.js 22.x, PostgreSQL 16+
2. **Clone** the repository
3. **Setup PostgreSQL** (see Database Setup below)
4. **Install dependencies:** `npm install`
5. **Build assets:** `npm run build`
6. **Configure** (optional): Copy `config/default.json5` to `config/development.json5` and customize
7. **Start dev server:** `npm run start-dev`
8. **Run tests:** `npm run test`

## Database Setup

The PostgreSQL DAL expects a dedicated user with full privileges on a primary database (`libreviews`) and on a single isolated test database (`libreviews_test`). The test harness provisions schemas on the fly, but it needs permission to create tables, sequences, and the `pgcrypto` extension in each database.

### 1. Install PostgreSQL 16 or newer

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib
```

**macOS (Homebrew):**
```bash
brew install postgresql
brew services start postgresql
```

### 2. Ensure PostgreSQL is running

**Linux:**
```bash
sudo service postgresql start
```

**macOS:** The installer usually starts PostgreSQL automatically. Use `brew services list` to confirm.

### 3. Create the application role and databases

**Using psql:**
```bash
sudo -u postgres psql

-- Create the login role
CREATE ROLE libreviews_user LOGIN PASSWORD 'libreviews_password';

-- Create the databases
CREATE DATABASE libreviews OWNER libreviews_user;
CREATE DATABASE libreviews_test OWNER libreviews_user;
\q
```

**Using command-line helpers:**
```bash
sudo -u postgres createuser --login --pwprompt libreviews_user
sudo -u postgres createdb libreviews -O libreviews_user
sudo -u postgres createdb libreviews_test -O libreviews_user
```

### 4. Grant permissions and enable extensions

Run the provided setup script:

```bash
sudo -u postgres psql -f dal/setup-db-grants.sql
```

This script:
- Grants `libreviews_user` all privileges on both databases
- Sets default privileges for future tables/sequences
- Installs the `pgcrypto` extension (needed for UUID generation)

### 5. Initialize the schema

Start the application once to run migrations:

```bash
npm run start-dev
```

The application automatically applies pending migrations on startup. You can stop it (Ctrl+C) after it finishes booting if you only need to initialize the database.

### Troubleshooting

- **Connection failures:** Verify PostgreSQL is running on `localhost:5432`
- **Permission errors:** Re-run `dal/setup-db-grants.sql`
- **Missing extensions:** Ensure `pgcrypto` exists in both databases
- **Asset build issues:** Delete `build/vite` and rebuild

## Development

### Running the dev server

```bash
npm run start-dev
```

This starts the server with debug output enabled. Visit `localhost` at the configured port (default: 80).

### Dev server with system tray icon (Linux)

If you're using a GNOME/GTK-based desktop environment:

```bash
npm run start-dev-yad
```

This requires `yad` (Yet Another Dialog), available in most Linux repositories. The tray icon allows you to toggle the server on/off and see server state at a glance.

### Configuration

Copy `config/default.json5` to `config/development.json5` to customize your local settings. See comments in the default config for available options.

### Running tests

```bash
npm run test
```

The test script automatically ensures a production Vite manifest exists, running `npm run build` if necessary before starting the AVA test suite.

## Technical Overview

lib.reviews is a pure-JavaScript application using modern language features.

| Technology | Purpose |
|-----------|---------|
| [Node.js](https://nodejs.org/en/) 22.x | Server, API, and tests |
| [Express](https://expressjs.com/) V5 | Web application framework |
| [PostgreSQL](https://www.postgresql.org/) | Primary storage backend |
| [ElasticSearch](https://www.elastic.co/) | Search backend |
| Custom DAL (`dal/`) | Data Access Layer with revision tracking |
| [Handlebars](http://handlebarsjs.com/) | Server-side templates |
| [LESS](http://lesscss.org/) | CSS pre-processor |
| [PureCSS](https://purecss.io/) | Grid system and base styles |
| [Vite](https://vite.dev/) | Build pipeline for front-end assets |
| [Babel](https://babeljs.io/) | JavaScript transpilation |
| [ava](https://github.com/avajs/ava) | Asynchronous test runner |
| [systemd](https://systemd.io/) | Production service supervision |
| [ProseMirror](http://prosemirror.net/) | Rich-text editor |
| [jQuery](https://jquery.com/) | DOM manipulation |

### Design Philosophy

- **Progressive Enhancement:** Client-side UI features are optional. Core functionality works without JavaScript and on low-end devices.
- **Keyboard Shortcuts:** We follow conventions from Wikipedia, Google, and other sites.
- **Multilingual:** UI and content support multiple languages. All user-facing strings are translatable.

## Code Style

- Use `// single-line comments` (easier to add/remove in bulk)

- For functions with more than two arguments, use destructured `options` or `spec` parameters:

  ```javascript
  let date = new Date(), user = 'unknown';
  hello({ recipient: 'World', sender: user, date });

  function hello(spec) {
    const { sender, recipient, date } = spec;
    console.log(`Hello ${recipient} from ${sender} on ${date}!`);
  }
  ```

  Exceptions: Functions accepting well-known standard arguments (e.g., `req, res, next` in Express).

- Object literals and arrow functions can be written on a single line

- We use [eslint](http://eslint.org/) with [babel-eslint](https://github.com/babel/babel-eslint). See [.eslintrc.json](https://github.com/permacommons/lib.reviews/blob/master/.eslintrc.json) for configuration.

- Semicolons are encouraged for navigating multi-line statements:

  ```javascript
  if (true)
    Promise.resolve()
      .then(() => console.log('Done'))
      .catch(() => console.log('Oh no'));
  ```

- Break chains for readability at ~3 or more chained calls

## Database Architecture

lib.reviews uses PostgreSQL with a custom Data Access Layer (DAL). See `dal/README.md` for detailed documentation.

### Key Features

- **Hybrid Schema:** Relational columns for structured data (IDs, timestamps, foreign keys), JSONB columns for multilingual content and flexible metadata
- **CamelCase Accessors:** Application code uses camelCase properties (`user.displayName`) that map to snake_case database columns (`display_name`)
- **Revision System:** Built-in versioning with partial indexes for performance
- **Multilingual Support:** JSONB-based language-keyed content with validation and fallback resolution

### Model Pattern

Models use a handle-based pattern that allows synchronous imports:

```javascript
// models/user.js
import dal from '../dal/index.js';
import { createModelModule } from '../dal/lib/model-handle.js';
import { initializeModel } from '../dal/lib/model-initializer.js';

const { proxy: UserHandle, register: registerUserHandle } = createModelModule({
  tableName: 'users'
});

const { types } = dal;

const schema = {
  id: types.string().uuid(4),
  displayName: types.string().max(128).required(),
  email: types.string().email()
};

async function initializeUserModel(dalInstance) {
  const { model } = initializeModel({
    dal: dalInstance,
    baseTable: 'users',
    schema
  });
  return model;
}

// dalInstance is provided by the DAL bootstrap when registering models.

registerUserHandle({
  initializeModel: initializeUserModel
});

export default UserHandle;
```

Usage in application code:

```javascript
import User from './models/user.js';

const user = await User.create({ displayName: 'Jane', email: 'jane@example.com' });
const users = await User.filter({ isTrusted: false }).run();
```

### Historical Note

Historical database dumps (from before 2025-10-30) are available in RethinkDB format and can be accessed with the last version of lib.reviews with RethinkDB (tagged `last-rethinkdb`). Migration tooling for RethinkDB dumps to PostgreSQL is available in the migrations/ directory checked in at tag `psql-switch`.

## Front-end Development

- **Build system:** Vite (`npm run build`), source in `frontend/` directory
- **Module system:** Not consistently using CommonJS yet (only in editor module)
- **Globals:** We minimize globals, but use:
  - `window.config` - Settings and UI messages specific to current user and page
  - `window.libreviews` - Progressive enhancement features and active rich-text editors

## Licensing and Conduct

Any pull requests must be under the [CC-0 License](./LICENSE). This project has adopted a [code of conduct](./CODE_OF_CONDUCT.md) to make sure all contributors feel welcome.
