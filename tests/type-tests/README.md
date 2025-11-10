# Type Tests

Compile-time type tests for backend code using `expect-type`.

## Running

```bash
npm run type-tests:backend
```

## Writing Tests

```typescript
expectTypeOf(value).toEqualTypeOf<ExpectedType>();  // exact equality
expectTypeOf(value).toMatchTypeOf<ExpectedType>();  // structural compatibility
```

These fail at compile-time if types don't match, not at runtime.
