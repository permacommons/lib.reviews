/**
 * Utility functions for generating URL-safe slugs from strings.
 *
 * @module util/slug
 */

import { decodeHTML } from 'entities';
import isUUID from 'is-uuid';

/**
 * Normalize a string into a slug-safe representation.
 *
 * This function:
 * - Unescapes HTML entities
 * - Converts to lowercase
 * - Replaces ampersands, spaces, underscores, and slashes with hyphens
 * - Removes specific punctuation characters that are problematic in URLs
 * - Collapses multiple consecutive hyphens into one
 * - Preserves non-ASCII Unicode characters (accented letters, Cyrillic, etc.)
 *
 * @param str - Source string to convert
 * @returns Slugified name suitable for URLs
 * @throws {Error} If string is not valid, empty, or would become a UUID
 *
 * @example
 * generateSlugName('Hello World!') // returns 'hello-world!'
 * generateSlugName('Café Münchën') // returns 'café-münchën'
 * generateSlugName('B&B Hotel') // returns 'b-b-hotel'
 * generateSlugName('foo & bar') // returns 'foo-bar'
 */
export function generateSlugName(str: string): string {
  if (typeof str !== 'string') {
    throw new Error('Source string is undefined or not a string.');
  }

  const trimmed = str.trim();
  if (trimmed === '') {
    throw new Error('Source string cannot be empty.');
  }

  const slugName = decodeHTML(trimmed)
    .trim()
    .toLowerCase()
    .replace(/[&]/g, '-') // Replace ampersands with hyphens
    .replace(/[?<>:"″'`‘’‛′“”‹›«»]/g, '') // Remove problematic punctuation
    .replace(/[ _/]/g, '-') // Replace spaces, underscores, slashes with hyphens
    .replace(/-{2,}/g, '-'); // Collapse multiple hyphens

  if (!slugName) {
    throw new Error('Source string cannot be converted to a valid slug.');
  }

  if (isUUID.v4(slugName)) {
    throw new Error('Source string cannot be a UUID.');
  }

  return slugName;
}
