import adapterMessagesJson from '../frontend/messages/adapter-keys.json' with { type: 'json' };
import editorMessagesJson from '../frontend/messages/editor-keys.json' with { type: 'json' };
import uploadModalMessagesJson from '../frontend/messages/upload-modal-keys.json' with {
  type: 'json',
};
import getMessages from './get-messages.ts';

/** Tuple of translation keys produced by the frontend build. */
type MessageKeyArray = readonly string[];

const uploadModalMessageKeys = Object.freeze([...(uploadModalMessagesJson as MessageKeyArray)]);
const editorMessageKeys = Object.freeze([...(editorMessagesJson as MessageKeyArray)]);
const adapterMessageKeys = Object.freeze([...(adapterMessagesJson as MessageKeyArray)]);

/**
 * Utility API that exposes localized strings required by the frontend bundles.
 * Methods return defensive copies to maintain the immutability contracts from
 * the original CommonJS helpers.
 */
const frontendMessages = {
  getUploadModalMessageKeys(): string[] {
    return [...uploadModalMessageKeys];
  },

  getEditorMessageKeys(): string[] {
    return [...editorMessageKeys];
  },

  getEditorMessages(locale: string): Record<string, string> {
    return getMessages(locale, editorMessageKeys);
  },

  getAdapterMessageKeys(): string[] {
    return [...adapterMessageKeys];
  },

  getAdapterMessages(locale: string): Record<string, string> {
    return getMessages(locale, adapterMessageKeys);
  },
};

export default frontendMessages;
