# Phase 4 Type System Design

This document outlines the target type system for Phase 4's registry-driven model architecture.

## Current Problems

### 1. Unused Generic Type Parameters
```typescript
// model-types.ts - Current (broken)
export interface ModelInstance<
  _TRecord extends JsonObject = JsonObject,  // ← Prefixed with _, unused
  _TVirtual extends JsonObject = JsonObject,
> {
  [key: string]: unknown;  // ← Any property allowed, no type safety
}

// Usage
const user: UserInstance = await User.get('123');
user.displayName;  // Type: unknown (no autocomplete)
user.typo;         // Type: unknown (no error!)
```

**Problem:** Generic parameters are intentionally unused, preventing type inference for model fields.

### 2. Duplicate ModelInstance Interface
- `dal/lib/model-types.ts` defines canonical `ModelInstance`
- `dal/lib/revision.ts` redefines a local `ModelInstance` with different signature
- Depending on import order, you get different types

### 3. No Distinction Between Base and Versioned Models
```typescript
// All models use the same interface, even though some have revisions
type UserInstance = ModelInstance<UserRecord, UserVirtual> & Record<string, any>;
type TeamInstance = ModelInstance<TeamRecord, TeamVirtual> & Record<string, any>;
```

**Problem:** Base models shouldn't have `newRevision()` method, but the type system doesn't enforce this.

### 4. Workaround Pattern Everywhere
```typescript
// Every model file does this
type UserInstance = ModelInstance<UserRecord, UserVirtual> & Record<string, any>;
//                                                           ^^^^^^^^^^^^^^^^^^^^
//                                                           Defeats type safety
```

## Target Architecture

### Core Principle: Zero DAL Exposure

**User code should never reference DALs.** Models are imported and used directly:

```typescript
import User from './models/user.ts';

const user = await User.get('123');  // Clean! No DAL, no getModel()
user.displayName;  // Fully typed
```

### 1. Proper Type Hierarchy

```typescript
// dal/lib/model-types.ts

// Base options types
export interface SaveOptions {
  skipValidation?: boolean;
  transaction?: PoolClient;
}

export interface DeleteOptions {
  soft?: boolean;
  transaction?: PoolClient;
}

// Base model instance (all models)
export interface ModelInstance<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> extends TRecord, TVirtual {
  // Internal fields (prefixed to avoid collision with model fields)
  readonly _data?: Record<string, unknown>;
  readonly _virtualFields?: Partial<TVirtual>;
  readonly _changed?: Set<string>;
  readonly _isNew?: boolean;
  readonly _originalData?: Record<string, unknown>;

  // Core CRUD methods (required, not optional)
  save(options?: SaveOptions): Promise<this>;
  delete(options?: DeleteOptions): Promise<boolean>;

  // Value access with proper constraints
  getValue<K extends keyof (TRecord & TVirtual)>(key: K): (TRecord & TVirtual)[K];
  setValue<K extends keyof TRecord>(key: K, value: TRecord[K]): void;

  // Virtual field generation
  generateVirtualValues(): void;
}

// Versioned model instance (models with hasRevisions: true)
export interface VersionedModelInstance<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> extends ModelInstance<TRecord, TVirtual> {
  // Revision fields
  _revID: string;
  _revUser: string;
  _revDate: Date;
  _revTags: string[];
  _revDeleted?: boolean;
  _oldRevOf?: string;

  // Revision methods
  newRevision<U extends ModelInstance>(
    user: U,
    options?: { tags?: string[]; date?: Date }
  ): Promise<this>;
  deleteAllRevisions(): Promise<void>;
}

// Constructor types
export interface ModelConstructor<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
> {
  new (...args: unknown[]): TInstance;
  tableName: string;

  // Static CRUD methods
  get(id: string, options?: GetOptions): Promise<TInstance>;
  getAll(...ids: string[]): Promise<TInstance[]>;
  filter(criteria: unknown): QueryBuilder;
  create(data: Partial<TRecord>, options?: JsonObject): Promise<TInstance>;
  update(id: string, data: Partial<TRecord>): Promise<TInstance>;
  delete(id: string): Promise<boolean>;

  // Other static methods
  define(name: string, handler: (...args: unknown[]) => unknown): void;
  defineRelation(name: string, config: JsonObject): void;

  prototype: TInstance;
}

export interface VersionedModelConstructor<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends VersionedModelInstance<TRecord, TVirtual> = VersionedModelInstance<TRecord, TVirtual>,
> extends ModelConstructor<TRecord, TVirtual, TInstance> {
  // Additional static methods for versioned models
  createFirstRevision(user: unknown, options?: JsonObject): Promise<TInstance>;
  getNotStaleOrDeleted(id: string, joinOptions?: JsonObject): Promise<TInstance>;
  filterNotStaleOrDeleted(): QueryBuilder;
  getMultipleNotStaleOrDeleted(ids: string[]): QueryBuilder;
}
```

### 2. Manifest-Based Model Definition

Each model file defines its manifest and exports a typed handle:

```typescript
// models/user.ts
import { createModel } from '../dal/lib/create-model.ts';
import types from '../dal/lib/type.ts';

const userManifest = {
  tableName: 'users',
  hasRevisions: false,  // ← Drives type generation
  schema: {
    id: types.string().uuid(4),
    displayName: types.string().max(128).required(),
    canonicalName: types.string().max(128).required(),
    email: types.string().email().sensitive(),
    password: types.string().sensitive(),
    registrationDate: types.date().default(() => new Date()),
    isTrusted: types.boolean().default(false),
    // ... more fields
  },
  camelToSnake: {
    displayName: 'display_name',
    canonicalName: 'canonical_name',
    registrationDate: 'registration_date',
    isTrusted: 'is_trusted',
    // ...
  },
  relations: [
    {
      name: 'teams',
      targetTable: 'teams',
      through: { table: 'team_members', /* ... */ },
      cardinality: 'many',
      hasRevisions: false,
    },
    // ... more relations
  ],
  staticMethods: {
    // Custom static methods
    async findByEmail(email: string) {
      return this.filter({ email }).first();
    },
  },
  instanceMethods: {
    // Custom instance methods
    async setPassword(password: string) {
      const bcrypt = await import('bcrypt');
      this.password = await bcrypt.hash(password, 10);
    },
  },
} as const;

// Creates properly typed handle + registers in global registry
const User = createModel(userManifest);

export default User;

// Usage in other files - completely clean!
// import User from './models/user.ts';
// const user = await User.get('123');
// user.displayName;  // Type: string ✓
// user.email;  // Type: string ✓
// await user.newRevision(currentUser);  // Works (versioned model) ✓
```

### 3. Type Inference from Manifest

```typescript
// dal/lib/model-handle.ts

type InferRecord<Schema> = {
  [K in keyof Schema]: Schema[K] extends { validate(v: unknown): infer T }
    ? T
    : unknown;
};

type InferVirtual<Schema> = {
  [K in keyof Schema as Schema[K] extends { isVirtual: true } ? K : never]:
    Schema[K] extends { validate(v: unknown): infer T } ? T : unknown;
};

type InferInstance<Manifest> =
  Manifest extends { hasRevisions: true }
    ? VersionedModelInstance<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>
      >
    : ModelInstance<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>
      >;

type InferConstructor<Manifest> =
  Manifest extends { hasRevisions: true }
    ? VersionedModelConstructor<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>,
        InferInstance<Manifest>
      >
    : ModelConstructor<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>,
        InferInstance<Manifest>
      >;

// Main function - returns properly typed handle
export function createModel<Manifest extends ModelManifest>(
  manifest: Manifest
): InferConstructor<Manifest> {
  // 1. Register manifest in global registry
  modelRegistry.set(manifest.tableName, manifest);

  // 2. Create lazy proxy that resolves on first use
  return new Proxy({} as InferConstructor<Manifest>, {
    get(target, prop) {
      // Lazy initialization from singleton DAL
      const model = getOrInitializeModel(manifest);
      return model[prop];
    },
  });
}
```

### 4. Global Registry (Internal Implementation Detail)

```typescript
// dal/lib/model-registry.ts

interface ModelManifest {
  tableName: string;
  hasRevisions: boolean;
  schema: Record<string, SchemaField>;
  camelToSnake?: Record<string, string>;
  relations?: RelationConfig[];
  staticMethods?: Record<string, Function>;
  instanceMethods?: Record<string, Function>;
}

// Global registry (hidden from user code)
const modelRegistry = new Map<string, ModelManifest>();

export function registerManifest(manifest: ModelManifest): void {
  modelRegistry.set(manifest.tableName, manifest);
}

export function getManifest(tableName: string): ModelManifest | undefined {
  return modelRegistry.get(tableName);
}

export function getAllManifests(): Map<string, ModelManifest> {
  return modelRegistry;
}
```

### 5. Bootstrap Integration

```typescript
// bootstrap/dal.ts
import dal from '../dal/index.ts';

// Import all models (triggers manifest registration via module loading)
import './models/user.ts';
import './models/team.ts';
import './models/thing.ts';
import './models/review.ts';
// ... all model imports

// Initialize DAL with all registered manifests
export async function initializeDAL() {
  await dal.connect();

  // Models auto-initialize on first use via lazy proxy
  // No explicit initialization needed!

  return dal;
}
```

### 6. Test Fixture Support

```typescript
// tests/fixtures/dal-fixture-ava.ts
import { createTestDAL } from '../../dal/lib/test-dal.ts';

export async function createFixture() {
  // Create isolated test DAL
  const testDAL = await createTestDAL();

  // Models automatically use test DAL when in test context
  // (detected via environment or explicit context setting)

  return { dal: testDAL };
}

// Usage in test
test('user creation', async (t) => {
  const { dal } = await createFixture();

  // User model automatically uses test DAL
  const user = await User.create({
    displayName: 'Test User',
    email: 'test@example.com',
  });

  t.truthy(user.id);
});
```

## Migration Path

### Step 1: Create Type Infrastructure
- Add `VersionedModelInstance` to model-types.ts
- Add `VersionedModelConstructor` to model-types.ts
- Add proper option types (`SaveOptions`, `DeleteOptions`, etc.)
- Update `ModelInstance` to extend `TRecord & TVirtual`
- **Status:** Complete

### Step 2: Build Registry System
- Create `dal/lib/model-registry.ts` for global registry
- Implement type inference helpers (`InferRecord`, `InferVirtual`, etc.)
- Update `createModel()` function to use manifest + registry
- **Status:** Complete

### Step 3: Migrate One Model (Proof of Concept)
- Choose simple model (e.g., `Team` - non-versioned)
- Convert to manifest format
- Verify types work correctly
- Ensure tests pass
- **Status:** Complete (`team.ts` migrated)

### Step 4: Migrate Remaining Models
- Convert each model file to manifest format
- Remove manual `initializeModel` calls
- Remove `& Record<string, any>` workarounds
- Verify types and tests for each
- **Status:** In progress (user migrated; review, thing, file, blog-post pending)

### Step 5: Core Type System Upgrade
- Update `ModelInstance`/`VersionedModelInstance` to require CRUD/revision methods without an index signature
- Tighten type builders so schema definitions infer concrete property types
- Apply contextual `ThisType` to manifest `staticMethods`/`instanceMethods`
- Define typed query builder interfaces (`filter`, `first`, `run`, etc.) keyed by inferred schema types
- Derive relation result types from manifest metadata
- Provide transitional helpers (if necessary) for legacy code during rollout

### Step 6: Cleanup
- Remove duplicate `ModelInstance` from `revision.ts`
- Remove old `initializeModel` function
- Update bootstrap to just import models
- Remove temporary compatibility code
- Drop remaining `Record<string, any>` escapes once typed instances ship

## Benefits

1. **Zero DAL Exposure**: User code never touches DAL - just import and use models
2. **Type Safety**: Full autocomplete and compile-time checking for all model fields
3. **No Workarounds**: Eliminate `& Record<string, any>` pattern completely
4. **Clear Distinction**: Base vs versioned models enforced by types
5. **Manifest as Truth**: Schema, relations, methods all in one place
6. **Better DX**: Developers get immediate feedback from TypeScript
7. **Maintainability**: Changes to manifest automatically propagate to types
8. **Test Isolation**: Fixtures can swap DAL without changing model code

## Examples

### Before (Phase 3)
```typescript
// models/user.ts - verbose, manual setup
type UserRecord = JsonObject;
type UserVirtual = JsonObject;
type UserInstance = ModelInstance<UserRecord, UserVirtual> & Record<string, any>;
type UserModel = ModelConstructor<UserRecord, UserVirtual, UserInstance> & Record<string, any>;

const { proxy: userHandleProxy, register: registerUserHandle } = createModelModule({
  tableName: 'users',
});

export async function initializeUserModel(dalInstance) {
  const { model } = initializeModel({
    dal: dalInstance,
    baseTable: 'users',
    schema: userSchema,
    camelToSnake: { /* ... */ },
    staticMethods: { /* ... */ },
    instanceMethods: { /* ... */ },
    relations: [ /* ... */ ],
  });
  return model;
}

// Usage
const user = await User.get('123');
user.displayName;  // unknown - no type safety
```

### After (Phase 4)
```typescript
// models/user.ts - clean, declarative
import { createModel } from '../dal/lib/model-handle.ts';
import types from '../dal/lib/type.ts';

const userManifest = {
  tableName: 'users',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),
    displayName: types.string().max(128).required(),
    email: types.string().email().sensitive(),
    // ...
  },
  camelToSnake: {
    displayName: 'display_name',
  },
  staticMethods: {
    async findByEmail(email: string) {
      return this.filter({ email }).first();
    },
  },
  instanceMethods: {
    async setPassword(password: string) {
      const bcrypt = await import('bcrypt');
      this.password = await bcrypt.hash(password, 10);
    },
  },
} as const;

const User = createModel(userManifest);
export default User;

// Usage - clean and fully typed!
import User from './models/user.ts';

const user = await User.get('123');
user.displayName;  // string ✓
user.email;  // string ✓
await user.newRevision(currentUser);  // works (versioned) ✓
await user.setPassword('newpass');  // custom method ✓

const found = await User.findByEmail('test@example.com');  // custom static ✓
```

### 3. Typed Method Contexts

Manifests declare `staticMethods` and `instanceMethods` as plain object literals.
The manifest helper layer is responsible for applying `ThisType` so TypeScript
infers the correct `this` value automatically:

- `instanceMethods` receive `this` typed as the inferred instance
  (`ModelInstance<TRecord, TVirtual>` or `VersionedModelInstance`).
- `staticMethods` receive `this` typed as the inferred constructor, including DAL helpers
  such as `filter`, `get`, `create`, and relation-aware query builders.

Model authors should not need to annotate `this: UserInstance` manually.

### 4. Typed Query Builders and Relations

The registry generates query builder types backed by the manifest metadata:

- `filter(criteria)` expects a `Partial<TRecord>` and produces a builder whose
  `first()`/`run()` methods resolve with the inferred instance type.
- Relation metadata describes the shape of eager-loaded collections
  (for example, `user.teams` resolves to `TeamInstance[]`).
- Methods like `getWithTeams` can return fully typed instances without sprinkling
  `Record<string, any>` fallbacks throughout the codebase.

The DAL infrastructure exposes these helpers; model files continue to declare
relations declaratively.

## Design Decisions

### Why Lazy Proxy Instead of Direct Export?
- **Circular dependencies**: Models can reference each other in relations
- **Test flexibility**: Fixtures can swap DAL without changing model code
- **Initialization control**: DAL connects once, models initialize on demand

### Why Global Registry?
- **Single source of truth**: All model definitions in one place (conceptually)
- **Bootstrap simplicity**: Just import models, registry auto-populates
- **Type generation**: Registry metadata drives conditional types

### Why Manifest Format?
- **Declarative**: Schema, relations, methods all visible in one structure
- **Type inference**: `as const` enables full type extraction
- **Migration friendly**: Easy to see what needs converting

### Why Keep Per-File Models?
- **Modularity**: Each model is self-contained
- **Import ergonomics**: `import User from './models/user'` is clean
- **Code organization**: Related code stays together
