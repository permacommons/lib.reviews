# PostgreSQL Data Access Layer (DAL)

The DAL provides the database interface for lib.reviews, featuring a Model-based system with camelCase accessors, revision tracking, and JSONB support for multilingual content.

## Architecture

The DAL is initialized once at application startup via `../db-postgres.mjs`. Models use a handle-based pattern that allows definitions to load synchronously while deferring actual initialization until the DAL is ready.

### Core Components

- **DataAccessLayer** (`lib/data-access-layer.mjs`) - Connection pooling, transactions, migrations
- **Model** (`lib/model.mjs`) - Base model class with CRUD operations, virtual fields, schema validation
- **QueryBuilder** (`lib/query-builder.mjs`) - Fluent query interface with filter, order, limit, join operations
- **Type System** (`lib/type.mjs`) - Type definitions and validation
- **Error Handling** (`lib/errors.mjs`) - Custom error classes and PostgreSQL error conversion
- **Multilingual Strings** (`lib/ml-string.mjs`) - JSONB-based multilingual string handling with language validation and fallback resolution
- **Revision System** (`lib/revision.mjs`) - Revision tracking and management
- **Model Infrastructure** - `model-handle.js`, `model-factory.mjs`, `model-registry.js`, `model-initializer.js` for model lifecycle management

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
// In models/user.mjs
import dal from '../dal/index.mjs';
import { createModelModule } from '../dal/lib/model-handle.mjs';
import { initializeModel } from '../dal/lib/model-initializer.mjs';

const { proxy: UserHandle, register: registerUserHandle } = createModelModule({
  tableName: 'users'
});

const { type } = dal;

const schema = {
  id: type.string().uuid(4),
  displayName: type.string().max(128).required(),
  email: type.string().email(),
  isTrusted: type.boolean().default(false)
};

async function initializeUserModel(dalInstance) {
  const { model } = initializeModel({
    dal: dalInstance,
    baseTable: 'users',
    schema
  });
  return model;
}

// dalInstance is supplied by the DAL bootstrap when registering models.
registerUserHandle({
  initializeModel: initializeUserModel
});

export default UserHandle;

// In routes or other code
import User from './models/user.mjs';

// Use the model
const user = await User.create({
  displayName: 'John Doe',
  email: 'john@example.com'
});

const users = await User.filter({ isTrusted: false }).run();
```

Multilingual strings:

```javascript
import dal from './dal/index.mjs';

const { mlString } = dal;

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
- `lib/data-access-layer.mjs` - Core DAL class
- `lib/model.mjs` - Base model implementation
- `lib/model-handle.js` - Model handle pattern for synchronous exports
- `lib/model-factory.mjs` - Model creation and registration
- `lib/model-registry.js` - Model registry for lookups
- `lib/model-initializer.mjs` - Model initialization logic
- `lib/query-builder.mjs` - Query building functionality
- `lib/type.mjs` - Type system and validation
- `lib/errors.mjs` - Error handling
- `lib/ml-string.mjs` - Multilingual string handling
- `lib/revision.mjs` - Revision tracking system
- `setup-db-grants.sql` - Database permissions setup script
- `../migrations/001_initial_schema.sql` - Database schema
