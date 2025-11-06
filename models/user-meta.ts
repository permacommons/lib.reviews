import { ValidationError } from '../dal/lib/errors.ts';
import { createModel } from '../dal/lib/create-model.ts';
import dal from '../dal/index.ts';
import types from '../dal/lib/type.ts';
import languages from '../locales/languages.ts';

const { mlString } = dal;
const { isValid: isValidLanguage } = languages;

// Manifest-based model definition
const userMetaManifest = {
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
} as const;

const UserMeta = createModel(userMetaManifest);

export default UserMeta;
