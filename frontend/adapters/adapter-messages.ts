import adapterMessageKeys from '../messages/adapter-keys.json';

export const adapterMessages: readonly string[] = Object.freeze([...adapterMessageKeys]);

/**
 * Return a shallow-copied array of adapter-specific i18n message keys
 * used by frontend adapter UIs. The copy ensures call sites cannot mutate
 * the underlying JSON source.
 *
 * @returns Array of adapter message keys
 */
export const getAdapterMessageKeys = (): string[] => [...adapterMessageKeys];

export default adapterMessages;
