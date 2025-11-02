import editorMessageKeysJson from './messages/editor-keys.json';

export type EditorMessageKey = string;

export const editorMessages = Object.freeze(
  [...editorMessageKeysJson] as readonly EditorMessageKey[]
);

export const getEditorMessageKeys = (): EditorMessageKey[] => [
  ...editorMessageKeysJson
];

export { getUploadModalMessageKeys } from './upload-modal-messages.ts';

export default editorMessages;