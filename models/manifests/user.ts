import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferData,
  InferInstance,
  InferVirtual,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
import type { GetOptions, ModelConstructor, ModelInstance } from '../../dal/lib/model-types.ts';
import types from '../../dal/lib/type.ts';
import type { UserMetaInstance } from './user-meta.ts';

const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6,
  illegalCharsReadable: '',
};

// Erm, if we add [, ] or \\ to forbidden chars, we'll have to fix this :)
userOptions.illegalCharsReadable = userOptions.illegalChars.source.replace(/[\[\]\\]/g, '');

/**
 * Canonicalize a username for case-insensitive comparison.
 *
 * @param name - Username to canonicalize
 * @returns Uppercase version of the name
 */
export function canonicalize(name: string): string {
  return name.toUpperCase();
}

/**
 * Validate that a username contains only legal characters.
 *
 * @param name - Username to validate
 * @returns True if valid
 * @throws Error if username contains illegal characters
 */
export function containsOnlyLegalCharacters(name: string): true {
  if (userOptions.illegalChars.test(name)) {
    throw new Error(`Username ${name} contains invalid characters.`);
  }
  return true;
}

const userSchema = {
  id: types.string().uuid(4),
  displayName: types
    .string()
    .max(userOptions.maxChars)
    .validator(containsOnlyLegalCharacters)
    .required(),
  canonicalName: types
    .string()
    .max(userOptions.maxChars)
    .validator(containsOnlyLegalCharacters)
    .required(),
  email: types.string().max(userOptions.maxChars).email().sensitive(),
  password: types.string().sensitive(),
  userMetaID: types.string().uuid(4),
  inviteLinkCount: types.number().integer().default(0),
  registrationDate: types.date().default(() => new Date()),
  showErrorDetails: types.boolean().default(false),
  isTrusted: types.boolean().default(false),
  isSiteModerator: types.boolean().default(false),
  isSuperUser: types.boolean().default(false),
  suppressedNotices: types.array(types.string()),
  prefersRichTextEditor: types.boolean().default(false),
  urlName: types
    .virtual()
    .returns<string | undefined>()
    .default(function (this: ModelInstance) {
      const displayName =
        typeof this.getValue === 'function' ? this.getValue('displayName') : this.displayName;
      return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
    }),
  userCanEditMetadata: types.virtual().returns<boolean>().default(false),
  userCanUploadTempFiles: types
    .virtual()
    .returns<boolean>()
    .default(function (this: ModelInstance) {
      const isTrusted =
        typeof this.getValue === 'function' ? this.getValue('isTrusted') : this.isTrusted;
      const isSuperUser =
        typeof this.getValue === 'function' ? this.getValue('isSuperUser') : this.isSuperUser;
      return Boolean(isTrusted || isSuperUser);
    }),
  meta: types.virtual().returns<ModelInstance | undefined>().default(undefined),
  teams: types.virtual().returns<ModelInstance[] | undefined>().default(undefined),
  moderatorOf: types.virtual().returns<ModelInstance[] | undefined>().default(undefined),
} as const;

type UserSchema = typeof userSchema;
type UserData = InferData<UserSchema>;
type UserVirtual = InferVirtual<UserSchema>;

type UserInstanceBase = ModelInstance<UserData, UserVirtual>;

type UserExtraStatics = {
  options: typeof userOptions;
};

export type UserAccessContext = {
  id: UserData['id'];
  isSuperUser?: UserData['isSuperUser'];
  isSiteModerator?: UserData['isSiteModerator'];
  isTrusted?: UserData['isTrusted'];
};

export interface CreateUserPayload {
  name: string;
  password: string;
  email?: UserData['email'];
}

export type UserInstanceMethods = {
  populateUserInfo(
    this: UserInstanceBase & UserInstanceMethods,
    user: UserAccessContext | null | undefined
  ): void;
  setName(this: UserInstanceBase & UserInstanceMethods, displayName: string): void;
  setPassword(this: UserInstanceBase & UserInstanceMethods, password: string): Promise<string>;
  checkPassword(this: UserInstanceBase & UserInstanceMethods, password: string): Promise<boolean>;
  getValidPreferences(this: UserInstanceBase & UserInstanceMethods): string[];
};

export type UserInstance = UserInstanceBase & UserInstanceMethods;

type UserModelBase = ModelConstructor<UserData, UserVirtual, UserInstance>;

type UserStaticThis = UserModel & UserExtraStatics;

export type UserView = Pick<
  UserInstance,
  | 'id'
  | 'displayName'
  | 'canonicalName'
  | 'email'
  | 'registrationDate'
  | 'isTrusted'
  | 'isSiteModerator'
  | 'isSuperUser'
> & {
  urlName?: UserInstance['urlName'];
};

export type UserStaticMethods = {
  create(this: UserStaticThis, userObj: CreateUserPayload): Promise<UserInstance>;
  ensureUnique(this: UserStaticThis, name: string): Promise<boolean>;
  getWithTeams(
    this: UserStaticThis,
    id: string,
    options?: GetOptions
  ): Promise<UserInstance | null>;
  findByURLName(
    this: UserStaticThis,
    name: string,
    options?: (GetOptions & { withData?: boolean; withTeams?: boolean }) | undefined
  ): Promise<UserInstance>;
  createBio(
    this: UserStaticThis,
    user: UserInstance,
    bioObj: Pick<UserMetaInstance, 'bio' | 'originalLanguage'>
  ): Promise<UserInstance>;
  canonicalize(this: UserStaticThis, name: string): string;
};

export type UserModel = UserModelBase & UserStaticMethods & UserExtraStatics;

const userManifest = defineModelManifest({
  tableName: 'users',
  hasRevisions: false,
  schema: userSchema,
  camelToSnake: {
    displayName: 'display_name',
    canonicalName: 'canonical_name',
    userMetaID: 'user_meta_id',
    inviteLinkCount: 'invite_link_count',
    registrationDate: 'registration_date',
    showErrorDetails: 'show_error_details',
    isTrusted: 'is_trusted',
    isSiteModerator: 'is_site_moderator',
    isSuperUser: 'is_super_user',
    suppressedNotices: 'suppressed_notices',
    prefersRichTextEditor: 'prefers_rich_text_editor',
  },
  relations: [
    {
      name: 'teams',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'team_members',
        sourceForeignKey: 'user_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
    {
      name: 'moderatorOf',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'team_moderators',
        sourceForeignKey: 'user_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
    {
      name: 'meta',
      targetTable: 'user_metas',
      sourceKey: 'user_meta_id',
      targetKey: 'id',
      hasRevisions: true,
      cardinality: 'one',
    },
  ] as const,
  views: {
    publicProfile: {
      project(user: InferInstance<typeof userManifest>) {
        return {
          id: user.id,
          displayName: user.displayName,
          canonicalName: user.canonicalName,
          email: user.email,
          registrationDate: user.registrationDate,
          isTrusted: user.isTrusted,
          isSiteModerator: user.isSiteModerator,
          isSuperUser: user.isSuperUser,
          urlName: user.urlName,
        } satisfies UserView;
      },
    },
  },
} as ModelManifest<UserSchema, false, UserStaticMethods, UserInstanceMethods>);

/**
 * Create a lazy reference to the User model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed User model constructor
 */
export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export { userOptions };

export default userManifest;
