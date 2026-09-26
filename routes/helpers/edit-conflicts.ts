import { isDeepStrictEqual } from 'node:util';
import escapeHTML from 'escape-html';
import isUUID from 'is-uuid';
import { z } from 'zod';
import type { HandlerRequest } from '../../types/http/handlers.ts';

/**
 * Name of the hidden form field that carries the revision ID an edit form
 * was loaded from.
 */
const REV_ID_FIELD = 'rev-id';

const normalizeRevID = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length ? value.trim() : undefined;

/**
 * Zod schema for the hidden revision ID field. Blank or missing values parse
 * to `undefined`.
 */
export const revIDField = z.preprocess(normalizeRevID, z.string().optional());

/**
 * Read the submitted revision ID from a request body without validating the
 * rest of the form.
 *
 * @param body
 *  Parsed request body
 * @returns The trimmed revision ID, or `undefined` if none was submitted
 */
export const getSubmittedRevID = (body: unknown): string | undefined =>
  body && typeof body === 'object'
    ? normalizeRevID((body as Record<string, unknown>)[REV_ID_FIELD])
    : undefined;

type RevisionedDocument = { id?: string; _revID?: string };

/**
 * Minimal model surface needed to load an older revision of a document.
 */
export interface RevisionLookupModel<TDocument> {
  filterWhere(criteria: Record<string, never>): {
    getRevisionByRevId(revID: string, documentID: string): { first(): Promise<TDocument | null> };
  };
}

/**
 * Determine whether saving an edit that was based on `submittedRevID` would
 * overwrite changes made since then. Newer revisions that leave the edited
 * values untouched (e.g., changes to other fields or other languages) are not
 * conflicts. If no revision ID was submitted, there is nothing to compare, so
 * this is never a conflict.
 *
 * @param model
 *  Model the document belongs to
 * @param current
 *  Freshly loaded current revision of the document
 * @param submittedRevID
 *  Revision ID the edit form was loaded from
 * @param selectEditedValues
 *  Returns the values the form edits from a given revision of the document
 * @returns `true` if the edit conflicts with a newer revision
 */
export async function hasEditConflict<TDocument extends RevisionedDocument>(
  model: RevisionLookupModel<TDocument>,
  current: TDocument,
  submittedRevID: string | undefined,
  selectEditedValues: (revision: TDocument) => unknown
): Promise<boolean> {
  if (!submittedRevID || submittedRevID === current._revID) return false;
  if (!current.id || !isUUID.v4(submittedRevID)) return true;

  const baseRevision = await model
    .filterWhere({})
    .getRevisionByRevId(submittedRevID, current.id)
    .first();
  if (!baseRevision) return true;

  return !isDeepStrictEqual(selectEditedValues(baseRevision), selectEditedValues(current));
}

/**
 * Add the edit conflict notice to the page errors shown with the edit form.
 *
 * @param req
 *  Request whose flash receives the notice
 * @param currentVersionURL
 *  Link to the current version of the document
 */
export const flashEditConflict = (req: HandlerRequest, currentVersionURL: string): void => {
  req.flash('pageErrors', req.__('edit conflict notice', escapeHTML(currentVersionURL)));
};
