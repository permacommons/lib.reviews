import dal from '../dal/index.js';
import { ValidationError } from '../dal/lib/errors.js';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.js';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';

type PostgresModule = typeof import('../db-postgres.js');

type UserMetaRecord = JsonObject;
type UserMetaVirtual = JsonObject;
type UserMetaInstance = ModelInstance<UserMetaRecord, UserMetaVirtual> & Record<string, any>;
type UserMetaModel = ModelConstructor<UserMetaRecord, UserMetaVirtual, UserMetaInstance> & Record<string, any>;

let postgresModulePromise: Promise<PostgresModule> | null = null;

async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise)
    postgresModulePromise = import('../db-postgres.js');

  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { types, mlString } = dal as unknown as { types: Record<string, any>; mlString: Record<string, any> };
const { isValid: isValidLanguage } = languages as unknown as { isValid: (code: string) => boolean };

let UserMeta: UserMetaModel | null = null;

/**
 * Initialize the PostgreSQL UserMeta model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if the DAL is unavailable
 */
export async function initializeUserMetaModel(dalInstance: Record<string, any> | null = null): Promise<UserMetaModel | null> {
  const activeDAL = dalInstance ?? await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping UserMeta model initialization');
    return null;
  }

  try {
    const multilingualStringSchema = mlString.getSchema({ maxLength: 1000 });

    const bioType = types.object()
      .default(() => ({ text: {}, html: {} }))
      .validator((value: unknown) => {
        if (value === null || value === undefined)
          return true;

        const record = value as Record<string, any>;
        multilingualStringSchema.validate(record.text, 'bio.text');
        multilingualStringSchema.validate(record.html, 'bio.html');
        return true;
      });

    const schema = {
      id: types.string().uuid(4),
      bio: bioType,
      originalLanguage: types.string()
        .max(4)
        .required(true)
        .validator((lang: string | null | undefined) => {
          if (lang === null || lang === undefined)
            return true;
          if (!isValidLanguage(lang))
            throw new ValidationError(`Invalid language code: ${lang}`, 'originalLanguage');
          return true;
        })
    } as JsonObject;

    const { model, isNew } = initializeModel<UserMetaRecord, UserMetaVirtual, UserMetaInstance>({
      dal: activeDAL as any,
      baseTable: 'user_metas',
      schema,
      camelToSnake: {
        originalLanguage: 'original_language'
      },
      withRevision: {
        static: [
          'createFirstRevision',
          'getNotStaleOrDeleted',
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted'
        ],
        instance: ['deleteAllRevisions']
      }
    });

    UserMeta = model as UserMetaModel;

    if (!isNew)
      return UserMeta;

    return UserMeta;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL UserMeta model');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

/**
 * Lazily initialize and return the PostgreSQL UserMeta model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if unavailable
 */
export async function getPostgresUserMetaModel(dalInstance: Record<string, any> | null = null): Promise<UserMetaModel | null> {
  UserMeta = await initializeUserMetaModel(dalInstance);
  return UserMeta;
}

const UserMetaHandle = createAutoModelHandle<UserMetaRecord, UserMetaVirtual, UserMetaInstance>(
  'user_metas',
  initializeUserMetaModel
);

export default UserMetaHandle;
export { initializeUserMetaModel as initializeModel };
