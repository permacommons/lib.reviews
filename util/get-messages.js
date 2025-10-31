import i18n from 'i18n';

/**
 * Resolve i18n message keys for the given locale.
 *
 * @param {string} locale
 * @param {...string[]} args - lists of translation keys
 * @returns {Record<string, string>}
 */
export default function getMessages(locale, ...args) {
  const messagesObj = {};
  for (const arg of args) {
    if (!Array.isArray(arg))
      continue;

    arg.forEach(key => {
      messagesObj[key] = i18n.__({
        phrase: key,
        locale
      });
    });
  }
  return messagesObj;
}
