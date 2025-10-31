import getMessages from './get-messages.mjs';
import uploadModalMessagesJson from '../frontend/messages/upload-modal-keys.json' with { type: 'json' };
import editorMessagesJson from '../frontend/messages/editor-keys.json' with { type: 'json' };
import adapterMessagesJson from '../frontend/messages/adapter-keys.json' with { type: 'json' };

const uploadModalMessageKeys = Object.freeze([...uploadModalMessagesJson]);
const editorMessageKeys = Object.freeze([...editorMessagesJson]);
const adapterMessageKeys = Object.freeze([...adapterMessagesJson]);

const frontendMessages = {
  getUploadModalMessageKeys() {
    return [...uploadModalMessageKeys];
  },

  getEditorMessageKeys() {
    return [...editorMessageKeys];
  },

  getEditorMessages(locale) {
    return getMessages(locale, editorMessageKeys);
  },

  getAdapterMessageKeys() {
    return [...adapterMessageKeys];
  },

  getAdapterMessages(locale) {
    return getMessages(locale, adapterMessageKeys);
  }
};

export default frontendMessages;
