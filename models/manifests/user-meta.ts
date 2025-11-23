import dal from '../../dal/index.ts';
import { ValidationError } from '../../dal/lib/errors.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance, ModelManifest } from '../../dal/lib/model-manifest.ts';
import languages from '../../locales/languages.ts';

const { mlString, types } = dal;
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

const userMetaManifest = {
  tableName: 'user_metas',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    bio: mlString.getRichTextSchema().default(() => ({ text: {}, html: {} })),
    originalLanguage: types
      .string()
      .max(4)
      .required(true)
      .validator((lang: string | null | undefined) => {
        if (lang === null || lang === undefined) return true;
        if (!isValidLanguage(lang))
          throw new ValidationError(`Invalid language code: ${lang}`, 'originalLanguage');
        return true;
      }),
  },
  camelToSnake: {
    originalLanguage: 'original_language',
  },
} as const satisfies ModelManifest;

export type UserMetaInstance = InferInstance<typeof userMetaManifest>;
export type UserMetaModel = InferConstructor<typeof userMetaManifest>;

/**
 * Create a lazy reference to the UserMeta model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed UserMeta model constructor
 */
export function referenceUserMeta(): UserMetaModel {
  return referenceModel(userMetaManifest) as UserMetaModel;
}

export default userMetaManifest;
