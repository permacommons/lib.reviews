import adapterMessageKeys from '../messages/adapter-keys.json';

export const adapterMessages = Object.freeze([...adapterMessageKeys]);

export const getAdapterMessageKeys = () => [...adapterMessageKeys];

export default adapterMessages;
