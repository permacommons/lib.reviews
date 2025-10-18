# PostgreSQL Data Access Layer (DAL)

This directory contains the PostgreSQL Data Access Layer implementation for the lib.reviews application migration from RethinkDB to PostgreSQL.

## Overview

The DAL provides a compatible interface with the existing Thinky ORM while using PostgreSQL as the backend database. It maintains the same API patterns to minimize changes to existing application code.

## Architecture

### Core Components

1. **DataAccessLayer** (`lib/data-access-layer.js`)
   - Main entry point for database operations
   - Connection pooling and management
   - Transaction support
   - Migration execution

2. **Model** (`lib/model.js`)
   - Base model class with CRUD operations
   - Virtual field support
   - Schema validation
   - Compatible with existing Thinky model patterns

3. **QueryBuilder** (`lib/query-builder.js`)
   - Fluent query interface
   - Filter, order, limit, and join operations
   - SQL query generation

4. **Type System** (`lib/type.js`)
   - Type definitions and validation
   - Compatible with Thinky type system
   - Support for string, number, boolean, date, array, and object types

5. **Error Handling** (`lib/errors.js`)
   - Custom error classes
   - PostgreSQL error conversion
   - Compatible with existing error handling

6. **Multilingual Strings** (`lib/ml-string.js`)
   - JSONB-based multilingual string handling
   - Language validation and fallback resolution
   - PostgreSQL query generation for JSONB fields
   - HTML stripping and content processing

## Database Schema

The migration uses a hybrid approach:

- **Relational columns** for: IDs, timestamps, booleans, integers, simple strings, foreign keys, revision fields
- **JSONB columns** for: Multilingual strings, complex nested objects, flexible metadata

### Key Features

- **Revision System**: Maintains the existing revision/versioning system with partial indexes for performance
- **Multilingual Support**: JSONB columns for language-keyed content
- **Performance Optimization**: Strategic indexing including GIN indexes for JSONB fields
- **Data Integrity**: Foreign key constraints and check constraints

## Usage

```javascript
const DAL = require('./dal');
const type = DAL.type;

// Initialize DAL
const dal = DAL({
  host: 'localhost',
  port: 5432,
  database: 'libreviews',
  user: 'postgres',
  password: 'password'
});

await dal.connect();
await dal.migrate();

// Create a model
const User = dal.createModel('users', {
  id: type.string().uuid(4),
  displayName: type.string().max(128).required(),
  email: type.string().email(),
  isTrusted: type.boolean().default(false)
});

// Use the model
const user = await User.create({
  displayName: 'John Doe',
  email: 'john@example.com'
});

// Multilingual string usage
const titleSchema = DAL.mlString.getSchema({ maxLength: 200 });
const multilingualTitle = {
  en: 'English Title',
  de: 'German Title',
  fr: 'French Title'
};

// Validate multilingual string
titleSchema.validate(multilingualTitle, 'title');

// Resolve to preferred language with fallbacks
const resolved = DAL.mlString.resolve('es', multilingualTitle); // Falls back to English

// Generate PostgreSQL queries for JSONB fields
const query = DAL.mlString.buildQuery('title', 'en', '%search%', 'ILIKE');
// Result: "title->>'en' ILIKE $1"
```

## Migration

The schema migration is located in `migrations/001_create_postgresql_schema.sql` and includes:

- All table definitions with hybrid relational/JSONB structure
- Critical indexes for performance (especially revision system)
- Foreign key constraints for data integrity
- JSONB GIN indexes for multilingual content search

## Compatibility

The DAL maintains compatibility with the existing Thinky ORM interface:

- Same method signatures for CRUD operations
- Compatible error handling
- Virtual field support
- Query builder patterns
- Model definition syntax

## Implementation Status

✅ **Completed:**
- Core DAL infrastructure
- Connection pooling and transaction support
- Base Model class with CRUD operations
- Query builder foundation
- Type system with validation
- Error handling and conversion
- PostgreSQL schema definition
- Migration system
- Multilingual string handling and validation for JSONB columns

🔄 **Future Enhancements:**
- Advanced join operations
- Full revision system integration
- Complex query patterns (function-based filters)
- Performance optimizations
- Comprehensive test coverage

## Files

- `index.js` - Main entry point
- `lib/data-access-layer.js` - Core DAL class
- `lib/model.js` - Base model implementation
- `lib/query-builder.js` - Query building functionality
- `lib/type.js` - Type system and validation
- `lib/errors.js` - Error handling
- `lib/ml-string.js` - Multilingual string handling
- `example-usage.js` - Usage examples
- `test-ml-string.js` - Multilingual string tests
- `../migrations/001_create_postgresql_schema.sql` - Database schema