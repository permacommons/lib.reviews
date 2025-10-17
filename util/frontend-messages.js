'use strict';

const getMessages = require('./get-messages');

const uploadModalMessageKeys = Object.freeze([
  ...require('../frontend/messages/upload-modal-keys.json')
]);

const editorMessageKeys = Object.freeze([
  ...require('../frontend/messages/editor-keys.json')
]);

const adapterMessageKeys = Object.freeze([
  ...require('../frontend/messages/adapter-keys.json')
]);

module.exports = {
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
