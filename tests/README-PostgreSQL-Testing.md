# PostgreSQL DAL Testing Guide

## How to Avoid DB Connection & Concurrency Issues

This guide documents the correct patterns for writing PostgreSQL DAL tests to avoid timeout issues, connection problems, and test concurrency conflicts.

## ❌ **WRONG APPROACH - Don't Do This**

### Problem: Separate Model Files with Custom DAL Instances
```javascript
// ❌ DON'T: Create separate model files that try to accept custom DAL instances
// models-postgres/user.js
function getPostgresUserModel(customDAL = null) {
  const dal = customDAL || getPostgresDAL();
  // This creates connection management issues
}

// ❌ DON'T: Try to pass DAL instances between test files and model files
test('My test', async t => {
  const fixture = createDALFixtureAVA();
  await fixture.bootstrap();
  const User = getPostgresUserModel(fixture.dal); // Connection issues!
});
```

**Why this fails:**
- Creates multiple DAL connections that aren't properly managed
- Test fixtures and model files use different connection pools
- Leads to timeout issues because connections don't close properly
- Makes test isolation difficult

## ✅ **CORRECT APPROACH - Do This Instead**

### Solution: Use DAL Fixture Pattern with Model Definitions

```javascript
// ✅ DO: Define models directly in test files using DAL fixture
import test from 'ava';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
const require = createRequire(import.meta.url);

// Use unique test instance to avoid conflicts
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-X'; // Use unique number!

const dalFixture = createDALFixtureAVA('testing-X');

function getModelDefinitions() {
  const type = require('../dal').type;
  const mlString = require('../dal').mlString;
  const revision = require('../dal').revision;
  
  return [
    {
      name: 'users',
      hasRevisions: false, // or true if model needs revision system
      schema: {
        id: type.string().uuid(4),
        display_name: type.string().max(128).required(),
        // ... other fields
        
        // Virtual fields
        url_name: type.virtual().default(function() {
          const displayName = this.getValue ? this.getValue('display_name') : this.display_name;
          return displayName ? encodeURIComponent(displayName.replace(/ /g, '_')) : undefined;
        })
      },
      options: {}
    }
  ];
}

test.before(async t => {
  try {
    // Bootstrap DAL with model definitions
    const modelDefs = getModelDefinitions();
    await dalFixture.bootstrap(modelDefs);
    
    // Add custom methods to models AFTER they're created
    const User = dalFixture.getModel('users');
    if (User) {
      // Add static methods
      User.customMethod = async function() { /* ... */ };
      
      // Add instance methods
      User.define('instanceMethod', function() { /* ... */ });
    }
    
    // Create test tables
    await dalFixture.createTestTables([
      {
        name: 'users',
        sql: `CREATE TABLE IF NOT EXISTS ${dalFixture.tablePrefix}users (...)`
      }
    ]);
  } catch (error) {
    t.log('PostgreSQL not available:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.after.always(async t => {
  await dalFixture.dropTestTables(['users']);
  await dalFixture.cleanup();
});

test('My test', async t => {
  const User = dalFixture.getModel('users');
  
  if (!User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }
  
  // Use the model normally
  const user = await User.create({ name: 'test' });
  t.truthy(user.id);
});
```

## 🔑 **Key Principles**

### 1. **One DAL Instance Per Test File**
- Each test file should create exactly ONE `dalFixture` instance
- Use `test.before()` and `test.after.always()` for setup/cleanup
- Never create multiple DAL connections in the same test file

### 2. **Unique Test Instances**
```javascript
// ✅ Use unique NODE_APP_INSTANCE for each test file
process.env.NODE_APP_INSTANCE = 'testing-1'; // DAL revision tests
process.env.NODE_APP_INSTANCE = 'testing-2'; // Other DAL tests  
process.env.NODE_APP_INSTANCE = 'testing-3'; // User/File model tests
process.env.NODE_APP_INSTANCE = 'testing-4'; // Integration tests
```

### 3. **Table Prefixes for Isolation**
- DAL fixture automatically adds prefixes like `testing_3_users`
- This prevents conflicts between concurrent test runs
- Always use `${dalFixture.tablePrefix}tablename` in SQL

### 4. **Model Creation Pattern**
```javascript
// ✅ Define models in test files, not separate files
function getModelDefinitions() {
  return [
    {
      name: 'modelname',
      hasRevisions: true/false,
      schema: { /* schema definition */ },
      options: {}
    }
  ];
}

// ✅ Add custom methods AFTER bootstrap
const Model = dalFixture.getModel('modelname');
Model.customStaticMethod = function() { /* ... */ };
Model.define('customInstanceMethod', function() { /* ... */ });
```

### 5. **Proper UUID Handling**
```javascript
// ✅ Always use proper UUIDs for revision fields
import { randomUUID } from 'crypto';

const file = await File.create({
  name: 'test.jpg',
  _rev_id: randomUUID(), // ✅ Not 'hardcoded-string'
  _rev_user: user.id,
  _rev_date: new Date(),
  _rev_tags: ['create']
});
```

### 6. **Virtual Field Definitions**
```javascript
// ✅ Handle virtual fields properly
url_name: type.virtual().default(function() {
  // Use getValue() method for reliable access to data
  const displayName = this.getValue ? this.getValue('display_name') : this.display_name;
  return displayName ? encodeURIComponent(displayName.replace(/ /g, '_')) : undefined;
}),

user_can_upload: type.virtual().default(function() {
  const isTrusted = this.getValue ? this.getValue('is_trusted') : this.is_trusted;
  const isSuperUser = this.getValue ? this.getValue('is_super_user') : this.is_super_user;
  return Boolean(isTrusted || isSuperUser); // ✅ Explicit Boolean conversion
})
```

### 7. **Query Building for Custom Methods**
```javascript
// ✅ Use model's tableName property for dynamic table names
File.getStashedUpload = async function(userID, name) {
  const query = `
    SELECT * FROM ${File.tableName}  -- ✅ Uses prefixed table name
    WHERE name = $1 AND uploaded_by = $2
  `;
  const result = await File.dal.query(query, [name, userID]);
  return result.rows.length > 0 ? File._createInstance(result.rows[0]) : undefined;
};
```

## 🚨 **Common Pitfalls to Avoid**

1. **Don't import model files in tests** - Define models in the test file itself
2. **Don't create multiple DAL instances** - One per test file maximum
3. **Don't hardcode table names** - Always use `${Model.tableName}` or `${dalFixture.tablePrefix}tablename`
4. **Don't hardcode UUIDs** - Use `randomUUID()` for revision fields
5. **Don't forget Boolean conversion** - Virtual fields returning falsy values need `Boolean()`
6. **Don't query virtual fields in SQL** - They don't exist in the database
7. **Don't reuse test instance numbers** - Each test file needs a unique `NODE_APP_INSTANCE`

## 📁 **File Organization**

```
tests/
├── fixtures/
│   └── dal-fixture-ava.mjs          # DAL fixture for test isolation
├── helpers/
│   └── dal-helpers-ava.mjs          # Helper functions for DAL tests
├── 10-dal-revision-system.mjs       # Uses testing-1
├── 11-user-file-models.mjs          # Uses testing-3  
├── 12-user-file-integration.mjs     # Uses testing-4
└── README-PostgreSQL-Testing.md     # This guide
```

## 🔧 **Debugging Connection Issues**

If you see timeout errors or "Cannot read properties of null":

1. **Check test instance uniqueness** - Make sure `NODE_APP_INSTANCE` is unique
2. **Verify model creation** - Add `console.log(dalFixture.getModel('modelname'))` 
3. **Check table prefixes** - Ensure SQL uses `${dalFixture.tablePrefix}tablename`
4. **Verify cleanup** - Make sure `test.after.always()` calls `dalFixture.cleanup()`
5. **Check UUID validation** - Ensure revision fields use `randomUUID()`

## ✅ **Success Indicators**

Your tests are properly set up when:
- All tests pass with `Exit Code: 0` (`npm test`)
- No timeout errors during test execution
- Tests can run concurrently without conflicts
- Database connections close properly after tests
- `npm test` completes successfully

Follow this pattern and you'll avoid connection and concurrency issues!