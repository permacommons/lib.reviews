import uploadModalMessageKeysJson from './messages/upload-modal-keys.json';

export type UploadModalMessageKey = string;

export const uploadModalMessages = Object.freeze([
  ...uploadModalMessageKeysJson,
] as readonly UploadModalMessageKey[]);

export const getUploadModalMessageKeys = (): UploadModalMessageKey[] => [
  ...uploadModalMessageKeysJson,
];

export default uploadModalMessages;
