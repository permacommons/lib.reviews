import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { ValidationError } from '../../dal/lib/errors.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';
import languages from '../../locales/languages.ts';

const { mlString } = dal as { mlString: Record<string, any> };
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

const userMetaManifest = defineModelManifest({
  tableName: 'user_metas',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),
    bio: types
      .object()
      .default(() => ({ text: {}, html: {} }))
      .validator((value: unknown) => {
        if (value === null || value === undefined) return true;

        const multilingualStringSchema = mlString.getSchema({ maxLength: 1000 });
        const record = value as Record<string, unknown>;
        multilingualStringSchema.validate(record.text, 'bio.text');
        multilingualStringSchema.validate(record.html, 'bio.html');
        return true;
      }),
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
});

export type UserMetaInstance = InferInstance<typeof userMetaManifest>;
export type UserMetaModel = InferConstructor<typeof userMetaManifest>;

export function referenceUserMeta(): UserMetaModel {
  return referenceModel(userMetaManifest) as UserMetaModel;
}

export default userMetaManifest;
