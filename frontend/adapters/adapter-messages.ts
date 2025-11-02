import adapterMessageKeys from '../messages/adapter-keys.json';

export const adapterMessages: readonly string[] = Object.freeze([...adapterMessageKeys]);

export const getAdapterMessageKeys = (): string[] => [...adapterMessageKeys];

export default adapterMessages;
