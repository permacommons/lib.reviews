import dal from 'rev-dal';
import type {
  InstanceMethodsFrom,
  ManifestInstance,
  ManifestModel,
  StaticMethodsFrom,
} from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { InferData, InferVirtual, ModelManifest } from 'rev-dal/lib/model-manifest';
import type { GetOptions, ModelConstructor, ModelInstance } from 'rev-dal/lib/model-types';
import type { TeamInstance } from './team.ts';
import type { UserMetaInstance } from './user-meta.ts';

const { types } = dal;

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
function containsOnlyLegalCharacters(name: string): true {
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
  themePreference: types.string().enum(['light', 'dark', 'system']),
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
  // Note: relation fields (meta, teams, moderatorOf) are typed via intersection pattern
} as const;

type UserData = InferData<typeof userSchema>;
type UserVirtual = InferVirtual<typeof userSchema>;
type UserInstanceBase = ModelInstance<UserData, UserVirtual>;

export type UserAccessContext = {
  id: UserData['id'];
  isSuperUser?: UserData['isSuperUser'];
  isSiteModerator?: UserData['isSiteModerator'];
  isTrusted?: UserData['isTrusted'];
};

export type UserRelations = {
  meta?: UserMetaInstance;
  teams?: TeamInstance[];
  moderatorOf?: TeamInstance[];
};

export interface CreateUserPayload {
  name: string;
  password: string;
  email?: UserData['email'];
}

export type UserView = Pick<
  UserInstanceBase,
  | 'id'
  | 'displayName'
  | 'canonicalName'
  | 'email'
  | 'registrationDate'
  | 'isTrusted'
  | 'isSiteModerator'
  | 'isSuperUser'
> & { urlName?: UserInstanceBase['urlName'] };

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
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
    themePreference: 'theme_preference',
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
  ],
  views: {
    publicProfile: {
      // Use UserInstanceBase to avoid circular reference with typeof userManifest
      project(user: UserInstanceBase) {
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
} as const satisfies ModelManifest;

type UserInstanceMethodsMap = {
  populateUserInfo(user: UserAccessContext | null | undefined): void;
  setName(displayName: string): void;
  setPassword(password: string): Promise<string>;
  checkPassword(password: string): Promise<boolean>;
  getValidPreferences(): string[];
};

type UserStaticMethodsMap = {
  create(userObj: CreateUserPayload): Promise<UserInstance>;
  ensureUnique(name: string): Promise<boolean>;
  getWithTeams(id: string, options?: GetOptions): Promise<UserInstance | null>;
  findByURLName(
    name: string,
    options?: (GetOptions & { withData?: boolean; withTeams?: boolean }) | undefined
  ): Promise<UserInstance>;
  createBio(
    user: UserInstance,
    bioObj: Pick<UserMetaInstance, 'bio' | 'originalLanguage'>
  ): Promise<UserInstance>;
  canonicalize(name: string): string;
};

export type UserInstanceMethods = InstanceMethodsFrom<
  typeof userManifest,
  UserInstanceMethodsMap,
  UserRelations
>;
export type UserInstance = ManifestInstance<typeof userManifest, UserInstanceMethods> &
  UserRelations;
export type UserStaticMethods = StaticMethodsFrom<
  typeof userManifest,
  UserStaticMethodsMap,
  UserInstanceMethods,
  UserRelations
>;

type UserExtraStatics = { options: typeof userOptions };
export type UserModel = ManifestModel<typeof userManifest, UserStaticMethods, UserInstanceMethods> &
  UserExtraStatics;

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
