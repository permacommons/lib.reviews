'use strict';

// External deps
const escapeHTML = require('escape-html');

// Internal deps
const languages = require('../../locales/languages');
const { validateFiles, cleanupFiles, getFileRevs, completeUploads } =
  require('../uploads');
const ReportedError = require('../../util/reported-error');
const File = require('../../models/file');
const api = require('../helpers/api');

/**
 * Process uploads via the API.
 *
 * @namespace APIUploadHandler
 */
module.exports = apiUploadHandler;

 /**
 * The main handler for processing upload attempts via the API. Kicks in after
 * the basic MIME check within the Multer middleware. Handles metadata
 * validation & creation of "File" revisions.
 *
 * @param {IncomingMessage} req
 *  Express request
 * @param {ServerResponse} res
 *  Express response
 * @returns {Function}
 *  callback invoked by the Multer middleware
 * @memberof APIUploadHandler
 */
function apiUploadHandler(req, res) {
  return fileFilterError => {

    // Status code will be used for known errors from the app, not for errors
    // from multer or unknown errors
    const abortUpload = (errors = []) => {
      cleanupFiles(req);
      const errorMessages = errors.map(error => {
        const rv = {};
        rv.internalMessage = error.message;
        if (error instanceof ReportedError)
          rv.displayMessage = req.__(...error.getEscapedUserMessageArray());
        return rv;
      });
      api.error(req, res, errorMessages);
    };

    if (fileFilterError)
      return abortUpload([fileFilterError]);

    if (!req.files.length)
      return abortUpload([new Error('No files received.')]);

    const validationErrors = validateAllMetadata(req.files, req.body);
    if (validationErrors.length)
      return abortUpload(validationErrors);

    validateFiles(req.files)
      .then(fileTypes => getFileRevs(req.files, fileTypes, req.user, ['upload', 'upload-via-api']))
      .then(fileRevs => addMetadata(req.files, fileRevs, req.body))
      .then(completeUploads)
      .then(fileRevs => Promise.all(fileRevs.map(fileRev => fileRev.save())))
      .then(fileRevs => reportUploadSuccess(req, res, fileRevs))
      .catch(error => abortUpload([error]));
  };
}

/**
 * Ensure that required fields have been submitted for each upload.
 *
 * @param {Object[]} files
 *  Files to validate
 * @param {Object} data
 *  Request data
 * @returns {Error[]}
 *  Validation errors, if any.
 * @memberof APIUploadHandler
 */
function validateAllMetadata(files, data) {
  const errors = [],
    processedFields = ['multiple'],
    multiple = Boolean(data.multiple);

  if (files.length > 1 && !multiple)
    errors.push(new Error(`Received more than one file, but 'multiple' flag is not set.`));

  for (let file of files) {
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
 * @param {Object} file
 *  File received from the upload middleware
 * @param {Object} data
 *  Request data that should contain the metadata we need
 * @param {Object} [options]
 *  Validation options
 * @param {Boolean} options.addSuffix=false
 *  Add a filename suffix to each field (used for requests with multiple files)
 * @returns {Error[]}
 *  Validation errors for this field, if any
 * @memberof APIUploadHandler
 */
function validateMetadata(file, data, { addSuffix = false } = {}) {
  const validLicenses = File.getValidLicenses();
  const errors = [],
    processedFields = [];
  // For multiple uploads, we use the filename as a suffix for each file
  const field = key => addSuffix ? `${key}-${file.originalname}` : key;
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
 * @param {Object} obj
 *  any object whose keys we want to validate
 * @param {String[]} [required=[]]
 *  keys which must access a truthy value
 * @param {String[]} [conditionallyIgnored=[]]
 *  keys which will be ignored _unless_ they access a truthy value
 * @returns {Error[]}
 *  errors for each validation issue or an empty array
 * @memberof APIUploadHandler
 */
function checkRequired(obj, required = [], conditionallyIgnored = []) {
  // Make a copy since we modify it below
  required = required.slice();

  const errors = [];
  for (let key in obj) {
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
 * @param {Object[]} files
 *  file objects received from the middleware
 * @param {File[]} fileRevs
 *  initial revisions of the File model, containing only the data that comes
 *  with the file itself (MIME type, filename, etc.)
 * @param {Ojbect} data
 *  request data
 * @returns {File[]}
 *  the revisions for further processing
 * @memberof APIUploadHandler
 */
function addMetadata(files, fileRevs, data) {
  const multiple = Boolean(data.multiple);
  fileRevs.forEach((fileRev, index) =>
    addMetadataToFileRev(files[index], fileRevs[index], data, { addSuffix: multiple })
  );
  return fileRevs;
}


/**
 * Add all relevant metadata to an individual file revision
 *
 * @param {Object} file
 *  file object from the middleware
 * @param {File} fileRev
 *  initial revision of the File model
 * @param {Object} data
 *  request data
 * @param {Object} [options]
 *  Validation options
 * @param {Boolean} options.addSuffix=false
 *  Add a filename suffix to each field (used for requests with multiple files)
 * @memberof APIUploadHandler
 */
function addMetadataToFileRev(file, fileRev, data, { addSuffix = false } = {}) {
  const field = key => addSuffix ? `${key}-${file.originalname}` : key;
  const addMlStr = (keys, rev) => {
    for (let key of keys)
      if (data[field(key)])
        rev[key] = {
          [data[field('language')]]: escapeHTML(data[field(key)])
        };
  };
  addMlStr(['description', 'creator', 'source'], fileRev);
  fileRev.license = data[field('license')];
}


/**
 * Send a success response to the API request that contains the newly assigned
 * filenames, so they can be used, e.g. in the editor.
 *
 * @param {IncomingMessage} req
 *  Express request
 * @param {ServerResponse} res
 *  Express response
 * @param {File[]} fileRevs
 *  the saved file metadata revisions
 * @memberof APIUploadHandler
 */
function reportUploadSuccess(req, res, fileRevs) {
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
