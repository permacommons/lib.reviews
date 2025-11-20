/**
 * Type tests for User model
 *
 * These tests verify that our manifest-based model system correctly infers types
 * from the schema definition. We're testing that:
 * 1. Instance properties match their schema definitions
 * 2. Virtual fields are properly typed
 * 3. Instance and static methods have correct signatures
 * 4. Method return types are sufficiently narrow for type safety
 */
import { expectTypeOf } from 'expect-type';
import type { ModelInstance } from '../../dal/lib/model-types.ts';
import User, { type UserInstance } from '../../models/user.ts';

// Test instance property types from schema
// We declare a const of the inferred type to test its properties without needing a real instance
declare const user: UserInstance;

// Required string fields - these should never be null/undefined
expectTypeOf(user.id).toEqualTypeOf<string>();
expectTypeOf(user.displayName).toEqualTypeOf<string>();
expectTypeOf(user.canonicalName).toEqualTypeOf<string>();

// Optional/nullable fields
expectTypeOf(user.email).toEqualTypeOf<string | null | undefined>();
expectTypeOf(user.password).toEqualTypeOf<string | null | undefined>();
expectTypeOf(user.userMetaID).toEqualTypeOf<string | null | undefined>();

// Number fields
expectTypeOf(user.inviteLinkCount).toEqualTypeOf<number | null | undefined>();

// Date fields
expectTypeOf(user.registrationDate).toEqualTypeOf<Date | null | undefined>();

// Boolean fields with defaults
expectTypeOf(user.showErrorDetails).toEqualTypeOf<boolean | null | undefined>();
expectTypeOf(user.isTrusted).toEqualTypeOf<boolean | null | undefined>();
expectTypeOf(user.isSiteModerator).toEqualTypeOf<boolean | null | undefined>();
expectTypeOf(user.isSuperUser).toEqualTypeOf<boolean | null | undefined>();
expectTypeOf(user.prefersRichTextEditor).toEqualTypeOf<boolean | null | undefined>();

// Array fields
expectTypeOf(user.suppressedNotices).toEqualTypeOf<string[] | null | undefined>();

// Virtual fields - computed properties defined with types.virtual().returns<T>()
expectTypeOf(user.urlName).toEqualTypeOf<string | undefined>();
expectTypeOf(user.userCanEditMetadata).toEqualTypeOf<boolean>();
expectTypeOf(user.userCanUploadTempFiles).toEqualTypeOf<boolean>();
expectTypeOf(user.meta).toEqualTypeOf<ModelInstance | undefined>();
expectTypeOf(user.teams).toEqualTypeOf<ModelInstance[] | undefined>();
expectTypeOf(user.moderatorOf).toEqualTypeOf<ModelInstance[] | undefined>();

// Test instance methods - these come from the manifest's instanceMethods
expectTypeOf(user.populateUserInfo).toBeFunction();
expectTypeOf(user.populateUserInfo).parameters.toMatchTypeOf<
  [Record<string, any> | null | undefined]
>();
expectTypeOf(user.populateUserInfo).returns.toEqualTypeOf<void>();

expectTypeOf(user.setName).toBeFunction();
expectTypeOf(user.setName).parameter(0).toEqualTypeOf<string>();
expectTypeOf(user.setName).returns.toEqualTypeOf<void>();

expectTypeOf(user.setPassword).toBeFunction();
expectTypeOf(user.setPassword).parameter(0).toEqualTypeOf<string>();
expectTypeOf(user.setPassword).returns.toEqualTypeOf<Promise<string>>();

expectTypeOf(user.checkPassword).toBeFunction();
expectTypeOf(user.checkPassword).parameter(0).toEqualTypeOf<string>();
expectTypeOf(user.checkPassword).returns.toEqualTypeOf<Promise<boolean>>();

expectTypeOf(user.getValidPreferences).toBeFunction();
expectTypeOf(user.getValidPreferences).returns.toEqualTypeOf<string[]>();

expectTypeOf(User.create).toBeFunction();
expectTypeOf(User.create).toBeCallableWith({ name: 'test', password: 'test123' });
// For proxy-wrapped static methods, we test return types via ReturnType extraction
// .toMatchTypeOf checks structural compatibility (the method returns something usable as UserInstance)
declare const createResult: Awaited<ReturnType<typeof User.create>>;
expectTypeOf(createResult).toMatchTypeOf<UserInstance>();

expectTypeOf(User.ensureUnique).toBeFunction();
expectTypeOf(User.ensureUnique).parameter(0).toEqualTypeOf<string>();
expectTypeOf(User.ensureUnique).returns.toEqualTypeOf<Promise<boolean>>();

expectTypeOf(User.get).toBeFunction();
expectTypeOf(User.get).returns.toMatchTypeOf<Promise<UserInstance | null>>();

expectTypeOf(User.getWithTeams).toBeFunction();
expectTypeOf(User.getWithTeams).returns.toMatchTypeOf<Promise<UserInstance | null>>();

expectTypeOf(User.findByURLName).toBeFunction();
// Although findByURLName throws when no user is found, the static typing still
// reflects the underlying query returning a nullable instance.
expectTypeOf(User.findByURLName).returns.toMatchTypeOf<Promise<UserInstance>>();

expectTypeOf(User.createBio).toBeFunction();
expectTypeOf(User.createBio).returns.toEqualTypeOf<Promise<UserInstance>>();

// Test that static canonicalize is available (from staticMethods)
expectTypeOf(User.canonicalize).toBeFunction();
expectTypeOf(User.canonicalize).parameter(0).toEqualTypeOf<string>();
expectTypeOf(User.canonicalize).returns.toEqualTypeOf<string>();

// Verify that values returned from Model.get() are correctly typed as UserInstance
// This ensures the type system understands the relationship between the model and its instances
declare const userFromModel: Awaited<ReturnType<typeof User.get>>;
if (userFromModel) {
  expectTypeOf(userFromModel).toMatchTypeOf<UserInstance>();
}

// Test DAL query builder chain returns properly typed results
const filterQuery = User.filterWhere({ displayName: 'test' }).includeDeleted().includeStale();
expectTypeOf(filterQuery.run()).toEqualTypeOf<Promise<UserInstance[]>>();
expectTypeOf(filterQuery.first()).toEqualTypeOf<Promise<UserInstance | null>>();

// Test that extra statics passed to defineModel() are available
// (User.options was passed via the statics: { options } parameter)
expectTypeOf(User.options).toMatchTypeOf<{
  maxChars: number;
  illegalChars: RegExp;
  minPasswordLength: number;
  illegalCharsReadable: string;
}>();
