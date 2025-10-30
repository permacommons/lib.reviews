# PostgreSQL Data Access Layer (DAL)

The DAL provides the database interface for lib.reviews, featuring a Model-based system with camelCase accessors, revision tracking, and JSONB support for multilingual content.

## Architecture

The DAL is initialized once at application startup via `../db-postgres.js`. Models use a handle-based pattern that allows definitions to load synchronously while deferring actual initialization until the DAL is ready.

### Core Components

- **DataAccessLayer** (`lib/data-access-layer.js`) - Connection pooling, transactions, migrations
- **Model** (`lib/model.js`) - Base model class with CRUD operations, virtual fields, schema validation
- **QueryBuilder** (`lib/query-builder.js`) - Fluent query interface with filter, order, limit, join operations
- **Type System** (`lib/type.js`) - Type definitions and validation
- **Error Handling** (`lib/errors.js`) - Custom error classes and PostgreSQL error conversion
- **Multilingual Strings** (`lib/ml-string.js`) - JSONB-based multilingual string handling with language validation and fallback resolution
- **Revision System** (`lib/revision.js`) - Revision tracking and management
- **Model Infrastructure** - `model-handle.js`, `model-factory.js`, `model-registry.js`, `model-initializer.js` for model lifecycle management

## Database Schema

Hybrid approach combining relational and JSONB columns:

- **Relational columns** for: IDs, timestamps, booleans, integers, simple strings, foreign keys, revision fields
- **JSONB columns** for: Multilingual strings, complex nested objects, flexible metadata

Key features:
- Revision system with partial indexes for performance
- JSONB multilingual support with GIN indexes
- Foreign key constraints and check constraints
- CamelCase JavaScript properties that map to snake_case database columns

## Usage

Models are defined using `createModelModule()` which returns a synchronous handle:

```javascript
// In models/user.js
const { createModelModule } = require('../dal/lib/model-handle');
const { proxy: UserHandle, register: registerUserHandle } = createModelModule({
  tableName: 'users'
});

module.exports = UserHandle;

// Later in the same file, define the schema
const { initializeModel } = require('../dal/lib/model-initializer');
const type = require('../dal').type;

const schema = {
  id: type.string().uuid(4),
  displayName: type.string().max(128).required(),
  email: type.string().email(),
  isTrusted: type.boolean().default(false)
};

registerUserHandle(initializeModel, schema, options);

// In routes or other code
const User = require('./models/user');

// Use the model
const user = await User.create({
  displayName: 'John Doe',
  email: 'john@example.com'
});

const users = await User.filter({ isTrusted: false }).run();
```

Multilingual strings:

```javascript
const { mlString } = require('./dal');

const titleSchema = mlString.getSchema({ maxLength: 200 });
const multilingualTitle = {
  en: 'English Title',
  de: 'German Title'
};

// Validate
titleSchema.validate(multilingualTitle, 'title');

// Resolve with fallbacks
const resolved = mlString.resolve('es', multilingualTitle); // Falls back to English

// Generate PostgreSQL queries
const query = mlString.buildQuery('title', 'en', '%search%', 'ILIKE');
// Result: "title->>'en' ILIKE $1"
```

## Files

- `index.js` - Main entry point
- `lib/data-access-layer.js` - Core DAL class
- `lib/model.js` - Base model implementation
- `lib/model-handle.js` - Model handle pattern for synchronous exports
- `lib/model-factory.js` - Model creation and registration
- `lib/model-registry.js` - Model registry for lookups
- `lib/model-initializer.js` - Model initialization logic
- `lib/query-builder.js` - Query building functionality
- `lib/type.js` - Type system and validation
- `lib/errors.js` - Error handling
- `lib/ml-string.js` - Multilingual string handling
- `lib/revision.js` - Revision tracking system
- `setup-db-grants.sql` - Database permissions setup script
- `../migrations/001_initial_schema.sql` - Database schema
