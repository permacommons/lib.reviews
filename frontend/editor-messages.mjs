import editorMessageKeys from './messages/editor-keys.json';

export const editorMessages = Object.freeze([...editorMessageKeys]);

export const getEditorMessageKeys = () => [...editorMessageKeys];

export { getUploadModalMessageKeys } from './upload-modal-messages.mjs';

export default editorMessages;
