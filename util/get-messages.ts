import i18n from 'i18n';
import type { MultilingualString } from 'rev-dal/lib/ml-string';

/**
 * Resolves i18n message keys for the given locale, merging multiple key lists
 * into a flat object that can be serialized to the frontend.
 */
export default function getMessages(
  locale: string,
  ...args: Array<readonly string[] | null | undefined>
): MultilingualString {
  const messagesObj: MultilingualString = {};
  for (const arg of args) {
    if (!arg) continue;

    for (const key of arg)
      messagesObj[key] = i18n.__({
        phrase: key,
        locale,
      });
  }
  return messagesObj;
}
