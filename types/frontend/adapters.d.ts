/**
 * Type definitions for frontend lookup and autocomplete adapters implemented
 * under `frontend/adapters/`.
 */

import type { MLString } from '../../frontend/libreviews';

/**
 * Thing data structure returned by the native lookup adapter when the
 * backend provides review subject metadata
 * (see `frontend/adapters/native-lookup-adapter.ts`).
 */
export interface Thing {
  urlID: string;
  urls?: string[];
  label?: import('../../frontend/libreviews.js').MLString;
  description?: import('../../frontend/libreviews.js').MLString;
  reviews?: Array<{ id: string }>;
}

/**
 * Result from a lookup adapter. Consumers like the review editor expect this
 * shape when populating the subject picker (see `frontend/review.ts`).
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
 * Error result from a failed lookup operation.
 */
export interface LookupError {
  error: Error;
}

/**
 * Data passed to update callbacks, mirroring the payload built inside the
 * abstract autocomplete adapter.
 */
export interface UpdateCallbackData {
  url: string;
  label: string;
  subtitle?: string;
  description?: string;
  thing?: Thing;
}

/** Function signature invoked when adapters deliver new data. */
export type UpdateCallback = (data: UpdateCallbackData) => void;

/**
 * Abstract lookup adapter interface implemented by `AbstractLookupAdapter`.
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
 * Abstract autocomplete adapter interface built on top of the lookup adapter
 * contract (see `frontend/adapters/abstract-autocomplete-adapter.ts`).
 */
export interface IAutocompleteAdapter extends ILookupAdapter {
  setupAutocomplete?(): void;
  removeAutocomplete?(): void;
  runAutocomplete?(): void;
}
