import escapeHTML from 'escape-html';

import languages from '../../locales/languages.ts';
import {
  validateFiles,
  cleanupFiles,
  getFileRevs,
  completeUploads
} from '../uploads.ts';
import ReportedError from '../../util/reported-error.ts';
import File from '../../models/file.ts';
import api from '../helpers/api.ts';
import type { HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';

type UploadFile = {
  originalname: string;
  filename: string;
  mimetype?: string;
  fieldname?: string;
  size?: number;
  path?: string;
  [key: string]: unknown;
};

type FileRevision = {
  id: string;
  description?: unknown;
  license?: string;
  creator?: unknown;
  source?: unknown;
  save: () => Promise<unknown>;
  [key: string]: unknown;
};

/**
 * completeUploads is invoked with an explicit uploadsDir from req.app.locals.paths.
 * This avoids per-module path guessing and keeps prod/dev parity.
 */

/**
 * Process uploads via the API.
 *
 * @namespace APIUploadHandler
 */
export default apiUploadHandler;

type UploadRequest = HandlerRequest<Record<string, string>, unknown, Record<string, any>> & {
  files: UploadFile[];
};

type UploadResponse = HandlerResponse;

/**
 * The main handler for processing upload attempts via the API. Kicks in after
 * the basic MIME check within the Multer middleware. Handles metadata
 * validation & creation of "File" revisions.
 *
 * @param req
 *  Express request
 * @param res
 *  Express response
 * @returns
 *  callback invoked by the Multer middleware
 * @memberof APIUploadHandler
 */
function apiUploadHandler(req: UploadRequest, res: UploadResponse) {
  return (fileFilterError?: unknown) => {

    // Status code will be used for known errors from the app, not for errors
    // from multer or unknown errors
    const abortUpload = (errors: Error[] = []) => {
      cleanupFiles(req);
      const errorMessages = errors.map(error => {
        const rv: Record<string, unknown> = {};
        rv.internalMessage = error.message;
        if (error instanceof ReportedError) {
          const userMessage = error.getEscapedUserMessageArray();
          if (Array.isArray(userMessage) && userMessage.length > 0) {
            const [message, ...params] = userMessage as [string, ...string[]];
            rv.displayMessage = req.__(message, ...params);
          }
        }
        return rv;
      });
      api.error(req, res, errorMessages);
    };

    if (fileFilterError instanceof Error)
      return abortUpload([fileFilterError]);
    if (fileFilterError && !(fileFilterError instanceof Error))
      return abortUpload([new Error(String(fileFilterError))]);

    if (!Array.isArray(req.files) || !req.files.length)
      return abortUpload([new Error('No files received.')]);

    const validationErrors = validateAllMetadata(req.files, req.body ?? {});
    if (validationErrors.length)
      return abortUpload(validationErrors);

    const persistRevisions = async (fileRevs: FileRevision[]): Promise<FileRevision[]> => {
      await Promise.all(fileRevs.map(fileRev => fileRev.save()));
      return fileRevs;
    };

    validateFiles(req.files)
      .then(fileTypes => getFileRevs(req.files, fileTypes, req.user, ['upload', 'upload-via-api']))
      .then(fileRevs => addMetadata(req.files, fileRevs as FileRevision[], req.body ?? {}))
      .then(fileRevs => completeUploads(fileRevs as unknown as FileRevision[], req.app.locals.paths.uploadsDir))
      .then(persistRevisions)
      .then(fileRevs => reportUploadSuccess(req, res, fileRevs))
      .catch(error => abortUpload([error instanceof Error ? error : new Error(String(error))]));
  };
}

/**
 * Ensure that required fields have been submitted for each upload.
 *
 * @param files
 *  Files to validate
 * @param data
 *  Request data
 * @returns
 *  Validation errors, if any.
 * @memberof APIUploadHandler
 */
function validateAllMetadata(files: UploadFile[], data: Record<string, any>): Error[] {
  const errors: Error[] = [],
    processedFields = ['multiple'],
    multiple = Boolean(data.multiple);

  if (files.length > 1 && !multiple)
    errors.push(new Error(`Received more than one file, but 'multiple' flag is not set.`));

  for (const file of files) {
    const validationResult = validateMetadata(file, data, { addSuffix: multiple });
    errors.push(...validationResult.errors);
    processedFields.push(...validationResult.processedFields);
  }
  const remainingFields = Object.keys(data).filter(key => !processedFields.includes(key));
  if (remainingFields.length > 0)
    errors.push(new Error(`Unknown parameter(s): ${remainingFields.join(', ')}`));

  return errors;
}


/**
 * Check that required metadata fields are present for a given upload. Also
 * ensures that language is valid, and that license is one of the accepted
 * licenses.
 *
 * @param file
 *  File received from the upload middleware
 * @param data
 *  Request data that should contain the metadata we need
 * @param options
 *  Validation options
 * @param options.addSuffix=false
 *  Add a filename suffix to each field (used for requests with multiple files)
 * @returns
 *  Validation errors for this field, if any
 * @memberof APIUploadHandler
 */
function validateMetadata(file: UploadFile, data: Record<string, any>, { addSuffix = false } = {}) {
  const validLicenses = (File as unknown as { getValidLicenses: () => string[] }).getValidLicenses();
  const errors: Error[] = [],
    processedFields: string[] = [];
  // For multiple uploads, we use the filename as a suffix for each file
  const field = (key: string) => addSuffix ? `${key}-${file.originalname}` : key;
  const ownWork = Boolean(data[field('ownwork')]);

  const required = ownWork ?
    ['description', 'license', 'ownwork', 'language'].map(field) :
    ['description', 'creator', 'source', 'license', 'language'].map(field);

  // We ignore presence/content of these conflicting fields if they are "falsy",
  // otherwise we report an error
  const conditionallyIgnored = ownWork ?
    ['creator', 'source'].map(field) :
    ['ownwork'].map(field);

  errors.push(...checkRequired(data, required, conditionallyIgnored));
  processedFields.push(...required, ...conditionallyIgnored);

  const language = data[field('language')];

  if (language && !languages.isValid(language))
    errors.push(new Error(`Language ${language} is not valid or recognized.`));

  const license = data[field('license')];
  if (license && !validLicenses.includes(license))
    errors.push(new Error(`License ${license} is not one of: ` +
      validLicenses.join(', ')));

  return { errors, processedFields };
}

/**
 * Check if we have "truthy" values for all required fields in a given object
 * (typically an API request body). Also throws errors if given fields are
 * present with a "truthy" value, which is useful for conflicting parameters
 * that may be submitted with empty values.
 *
 * @param obj
 *  any object whose keys we want to validate
 * @param required
 *  keys which must access a truthy value
 * @param conditionallyIgnored
 *  keys which will be ignored _unless_ they access a truthy value
 * @returns
 *  errors for each validation issue or an empty array
 * @memberof APIUploadHandler
 */
function checkRequired(
  obj: Record<string, any>,
  required: string[] = [],
  conditionallyIgnored: string[] = []
): Error[] {
  // Make a copy since we modify it below
  required = required.slice();

  const errors: Error[] = [];
  for (const key in obj) {
    if (required.includes(key)) {
      if (!obj[key])
        errors.push(new Error(`Parameter must not be empty: ${key}`));
      required.splice(required.indexOf(key), 1);
    }
    if (conditionallyIgnored.includes(key) && Boolean(obj[key]))
      errors.push(new Error(`Parameter must be skipped, be empty, or evaluate to false: ${key}`));

  }
  if (required.length)
    errors.push(new Error(`Missing the following parameter(s): ${required.join(', ')}`));

  return errors;
}


/**
 * Add all metadata to each file revision (does not save)
 *
 * @param files
 *  file objects received from the middleware
 * @param fileRevs
 *  initial revisions of the File model, containing only the data that comes
 *  with the file itself (MIME type, filename, etc.)
 * @param data
 * @returns
 *  the revisions for further processing
 * @memberof APIUploadHandler
 */
function addMetadata(files: UploadFile[], fileRevs: FileRevision[], data: Record<string, any>) {
  const multiple = Boolean(data.multiple);
  fileRevs.forEach((fileRev, index) =>
    addMetadataToFileRev(files[index], fileRevs[index], data, { addSuffix: multiple })
  );
  return fileRevs;
}


/**
 * Add all relevant metadata to an individual file revision
 *
 * @param file
 *  file object from the middleware
 * @param fileRev
 *  initial revision of the File model
 * @param data
 *  request data
 * @param options
 *  Validation options
 * @param options.addSuffix=false
 *  Add a filename suffix to each field (used for requests with multiple files)
 * @memberof APIUploadHandler
 */
function addMetadataToFileRev(file: UploadFile, fileRev: FileRevision, data: Record<string, any>, { addSuffix = false } = {}) {
  const field = (key: string) => addSuffix ? `${key}-${file.originalname}` : key;
  const addMlStr = (keys: string[], rev: Record<string, any>) => {
    for (const key of keys)
      if (data[field(key)])
        rev[key] = {
          [data[field('language')]]: escapeHTML(String(data[field(key)]))
        };
  };
  addMlStr(['description', 'creator', 'source'], fileRev);
  fileRev.license = data[field('license')];
}


/**
 * Send a success response to the API request that contains the newly assigned
 * filenames, so they can be used, e.g. in the editor.
 *
 * @param req
 *  Express request
 * @param res
 *  Express response
 * @param fileRevs
 *  the saved file metadata revisions
 * @memberof APIUploadHandler
 */
function reportUploadSuccess(req: UploadRequest, res: UploadResponse, fileRevs: FileRevision[]) {
  const uploads = req.files.map((file, index) => ({
    originalName: file.originalname,
    uploadedFileName: file.filename,
    fileID: fileRevs[index].id,
    description: fileRevs[index].description,
    license: fileRevs[index].license,
    creator: fileRevs[index].creator,
    source: fileRevs[index].source
  }));
  res.status(200);
  res.type('json');
  res.send(JSON.stringify({
    message: 'Upload successful.',
    uploads,
    errors: []
  }, null, 2));
}
