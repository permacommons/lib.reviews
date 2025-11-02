/**
 * Type definitions for frontend lookup and autocomplete adapters
 */

import type { MLString } from '../../frontend/libreviews';

/**
 * Thing data structure returned by native adapter
 */
export interface Thing {
  urlID: string;
  urls?: string[];
  label?: import('../../frontend/libreviews.js').MLString;
  description?: import('../../frontend/libreviews.js').MLString;
  reviews?: Array<{ id: string }>;
}

/**
 * Result from a lookup adapter
 */
export interface LookupResult {
  data: {
    label: string;
    subtitle?: string;
    description?: string;
    thing?: Thing;
  };
  sourceID: string;
}

/**
 * Error result from a failed lookup
 */
export interface LookupError {
  error: Error;
}

/**
 * Data passed to update callbacks
 */
export interface UpdateCallbackData {
  url: string;
  label: string;
  subtitle?: string;
  description?: string;
  thing?: Thing;
}

/**
 * Update callback function type
 */
export type UpdateCallback = (data: UpdateCallbackData) => void;

/**
 * Abstract lookup adapter interface
 */
export interface ILookupAdapter {
  sourceID?: string;
  supportedPattern?: RegExp;
  updateCallback?: UpdateCallback | Function | null;

  ask(url: string): boolean;
  lookup(url: string): Promise<LookupResult>;
  getSourceID(): string;
}

/**
 * Abstract autocomplete adapter interface
 */
export interface IAutocompleteAdapter extends ILookupAdapter {
  setupAutocomplete?(): void;
  removeAutocomplete?(): void;
  runAutocomplete?(): void;
}
