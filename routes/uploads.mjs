/**
 * Process uploads via the web (provides general functions shared by the API).
 *
 * @namespace Uploads
 */

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import isSVG from 'is-svg';
import config from 'config';
import is from 'type-is';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { generateToken, getTokenFromRequest, getTokenFromState, invalidCsrfTokenError } from '../util/csrf.mjs';
import File from '../models/file.mjs';
import getResourceErrorHandler from './handlers/resource-error-handler.mjs';
import render from './helpers/render.mjs';
import slugs from './helpers/slugs.mjs';
import debug from '../util/debug.mjs';
import ReportedError from '../util/reported-error.mjs';
import languages from '../locales/languages.mjs';
import forms from './helpers/forms.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readFile = promisify(fs.readFile);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
const stage1Router = express.Router();
const stage2Router = express.Router();

let fileTypeFromFileFn;
async function detectFileType(filePath) {
  if (!fileTypeFromFileFn) {
    ({ fileTypeFromFile: fileTypeFromFileFn } = await import('file-type'));
  }
  return fileTypeFromFileFn(filePath);
}

const allowedTypes = [
  'image/png', 'image/gif', 'image/svg+xml', 'image/jpeg', 'image/webp',
  'video/webm', 'video/ogg',
  'audio/ogg', 'audio/mpeg'
];

// You can upload multiple uploads in one batch; this form is used to process
// the metadata
const uploadFormDef = [{
    name: 'upload-language',
    required: true
  }, {
    name: 'upload-%uuid',
    required: false,
    keyValueMap: 'uploads'
  }, {
    name: 'upload-%uuid-description',
    required: false,
    type: 'text',
    keyValueMap: 'descriptions'
  }, {
    name: 'upload-%uuid-by',
    required: false,
    type: 'string', // can be 'uploader' or 'other'
    keyValueMap: 'creators'
  }, {
    required: false,
    name: 'upload-%uuid-creator',
    type: 'text',
    keyValueMap: 'creatorDetails'
  },
  {
    name: 'upload-%uuid-source',
    required: false,
    type: 'text',
    keyValueMap: 'sources'
  },
  {
    name: 'upload-license-%uuid',
    required: false,
    type: 'string', // enum defined in model
    keyValueMap: 'licenses'
  }
];

// Uploading is a two step process. In the first step, the user simply posts the
// file or files. In the second step, they provide information such as the
// license and description. This first step has to be handled prior to the CSRF
// middleware because of the requirement of managing upload streams and
// multipart forms.
//
// Whether or not an upload is finished, as long as we have a valid file, we
// keep it on disk, initially in a temporary directory. We also create a
// record in the "files" table for it that can be completed later.
stage1Router.post('/:id/upload', function(req, res, next) {

  // On to stage 2
  if (!is(req, ['multipart']))
    return next();

  let id = req.params.id.trim();
  slugs.resolveAndLoadThing(req, res, id)
    .then(thing => {

      thing.populateUserInfo(req.user);
      if (!thing.userCanUpload)
        return render.permissionError(req, res, {
          titleKey: 'add media'
        });

      let storage = multer.diskStorage({
        destination: config.uploadTempDir,
        filename: assignFilename
      });

      let upload = multer({
        limits: {
          fileSize: config.uploadMaxSize
        },
        fileFilter: getFileFilter(req, res),
        storage
      }).array('media');

      // Execute the actual upload middleware
      upload(req, res, getUploadHandler(req, res, next, thing));
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});


// Note that at the time the filter runs, we won't have the complete file yet,
// so we may temporarily store files and delete them later if, after
// investigation, they turn out to contain unacceptable content.
function getFileFilter(req, res) {
  return (req, file, done) => {
    const { fileTypeError, isPermitted } = checkMIMEType(file);
    return done(fileTypeError, isPermitted);
  };
}

// Check if MIME type appears okay. That doesn't mean the file is acceptable -
// file could be pretending to be something it isn't
function checkMIMEType(file) {
  if (!allowedTypes.includes(file.mimetype))
    return {
      fileTypeError: new ReportedError({
        userMessage: 'unsupported file type',
        userMessageParams: [file.originalname, file.mimetype]
      }),
      isPermitted: false
    };
  else
    return {
      fileTypeError: null,
      isPermitted: true
    };
}

// Checks validity of the files and, if appropriate, performs the actual upload
function getUploadHandler(req, res, next, thing) {
  return error => {

    const abortUpload = uploadError => {
      // Async, but we don't wait for completion. Note that multer performs
      // its own cleanup on fileFilter errors, and req.files will be an empty
      // array in that case.
      cleanupFiles(req);
      req.flashError(uploadError);
      res.redirect(`/${thing.urlID}`);
    };

    // Validate CSRF token first (now that req.body is populated by multer).
    // This ensures temp files are immediately cleaned up if CSRF is invalid.
    const submittedToken = getTokenFromRequest(req);
    const storedToken = getTokenFromState(req);

    if (!submittedToken || !storedToken || submittedToken !== storedToken) {
      return abortUpload(invalidCsrfTokenError);
    }

    // An error at this stage most likely means an unsupported file type was among the batch.
    // We reject the whole batch and report the bad apple.
    if (error)
      return abortUpload(error);

    if (req.files.length) {
      validateFiles(req.files)
        .then(fileTypes => getFileRevs(req.files, fileTypes, req.user,
          ['upload', 'upload-via-form']))
        .then(fileRevs => attachFileRevsToThing(fileRevs, thing))
        .then(uploadedFiles =>
          render.template(req, res, 'thing-upload-step-2', {
            titleKey: 'add media',
            thing,
            uploadedFiles,
            csrfToken: generateToken(req)
          })
        )
        .catch(abortUpload);
    } else {
      req.flash('pageErrors', req.__('no file received'));
      res.redirect(`/${thing.urlID}`);
    }
  };
}

async function validateFiles(files) {
  let validators = [];
  files.forEach(file => {
    // SVG files need full examination
    if (file.mimetype != 'image/svg+xml')
      validators.push(validateFile(file.path, file.mimetype));
    else
      validators.push(validateSVG(file.path));
  });
  const fileTypes = await Promise.all(validators);
  return fileTypes;
}

async function getFileRevs(files, fileTypes, user, tags = []) {
  const fileRevs = await Promise.all(
    files.map(() => File.createFirstRevision(user, { tags }))
  );
  files.forEach((file, index) => {
    fileRevs[index].name = file.filename;
    // We don't use the reported MIME type from the upload
    // because it may be wrong in some edge cases like Ogg
    // audio vs. Ogg video
    fileRevs[index].mimeType = fileTypes[index];
    fileRevs[index].uploadedBy = user.id;
    fileRevs[index].uploadedOn = new Date();
  });
  return fileRevs;
}

async function attachFileRevsToThing(fileRevs, thing) {
  // Note that the file association is stored in a separate table, so we do not
  // create a new Thing revision in this case
  if (!Array.isArray(fileRevs) || !fileRevs.length) {
    return [];
  }

  if (!Array.isArray(thing.files)) {
    thing.files = [];
  }

  fileRevs.forEach(fileRev => {
    thing.addFile(fileRev);
  });

  await Promise.all(fileRevs.map(fileRev => fileRev.save()));
  await thing.saveAll({ files: true });
  return fileRevs;
}

async function cleanupFiles(req) {
  if (!Array.isArray(req.files) || !req.files.length)
    return;

  try {
    await Promise.all(req.files.map(file => unlink(file.path)));
  } catch (error) {
    debug.error({ error, req });
  }
}

// Verify that a file's contents match its claimed MIME type. This is shallow,
// fast validation. If files are manipulated, we need to pay further attention
// to any possible exploits.
async function validateFile(filePath, claimedType) {
  const type = await detectFileType(filePath);

  // Browser sometimes misreports media type for Ogg files. We don't throw an
  // error in this case, but return the correct type.
  const allOgg = (...types) => types.every(type => /\/ogg$/.test(type));

  if (!type)
    throw new ReportedError({
      userMessage: 'unrecognized file type',
      userMessageParams: [path.basename(filePath)],
    });
  else if (type.mime !== claimedType && !allOgg(type.mime, claimedType))
    throw new ReportedError({
      userMessage: 'mime mismatch',
      userMessageParams: [path.basename(filePath), claimedType, type.mime],
    });
  else
    return type.mime;
}

// SVGs can't be validated by magic number check. This, too, is a relatively
// shallow validation, not a full XML parse.
async function validateSVG(filePath) {
  const data = await readFile(filePath);
  if (isSVG(data))
    return 'image/svg+xml';
  else
    throw new ReportedError({
      userMessage: 'not valid svg',
      userMessageParams: [path.basename(filePath)],
    });
}

// If an upload is unfinished, it can still be viewed at its destination URL
// by the user who uploaded it.
stage1Router.get('/static/uploads/restricted/:name', function(req, res, next) {
  if (!req.user)
    return next();

  File
    .getStashedUpload(req.user.id, req.params.name)
    .then(upload => {
      if (!upload)
        return next();
      res.sendFile(path.join(config.uploadTempDir, upload.name));
    })
    .catch(next);
});

// This route handles step 2 of a file upload, the addition of metadata.
// Step 1 is handled as an earlier middleware in process-uploads.js, due to the
// requirement of handling file streams and a multipart form.
stage2Router.post('/:id/upload', function(req, res, next) {
  let id = req.params.id.trim();
  slugs.resolveAndLoadThing(req, res, id)
    .then(thing => {

      thing.populateUserInfo(req.user);
      if (!thing.userCanUpload)
        return render.permissionError(req, res, {
          titleKey: 'add media'
        });

      processUploadForm(req, res, next, thing);

    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
});

function processUploadForm(req, res, next, thing) {

  // Flash a message from a [key, param1, ...] array, then redirect to thing
  const redirectBack = ({ message, error } = {}) => {
    if (Array.isArray(error))
      req.flash('pageErrors', req.__(...error));
    if (Array.isArray(message))
      req.flash('pageMessages', req.__(...message));

     res.redirect(`/${thing.urlID}`);
   };

  let language = req.body['upload-language'];

  if (!languages.isValid(language))
    return redirectBack({ error: ['invalid language code', language] });

  let formData = forms.parseSubmission(req, {
    formDef: uploadFormDef,
    formKey: 'upload-file',
    language
  });

  if (req.flashHas('pageErrors'))
    return redirectBack();

  let uploadIDs;
  let hasUploads = typeof formData.formValues.uploads == 'object' &&
    (uploadIDs = Object.keys(formData.formValues.uploads)).length;

  if (!hasUploads)
    return redirectBack({ error: ['data missing'] });

  const getFiles = async uploadIDs =>
    await Promise.all(uploadIDs.map(File.getNotStaleOrDeleted));

  // Load file info from stage 1 using the upload IDs from the form. Parse the
  // form and abort if there's a problem with any given upload. If there's no
  // problem, move the upload to its final location, update its metadata and
  // mark it as finished.
  getFiles(uploadIDs)
    .then(files => processUploads(files, formData.formValues, language))
    .then(() => redirectBack({ message: ['upload completed'] }))
    .catch(error => {
      req.flashError(error);
      redirectBack();
    });
}


async function processUploads(uploads, formValues, language) {
    let completeUploadPromises = [];
    uploads.forEach(upload => {

      let getVal = obj => !Array.isArray(obj) || !obj[upload.id] ? null : obj[upload.id];

      upload.description = getVal(formValues.descriptions);

      if (!upload.description || !upload.description[language])
        throw new ReportedError({
          message: `Form data for upload %s lacks a description.`,
          messageParams: [upload.name],
          userMessage: 'upload needs description',
        });

      let by = getVal(formValues.creators);
      if (!by)
        throw new ReportedError({
          message: `Form data for upload missing creator information.`,
          userMessage: 'data missing'
        });

      if (by === 'other') {
        upload.creator = getVal(formValues.creatorDetails);

        if (!upload.creator || !upload.creator[language])
          throw new ReportedError({
            message: 'Form data for upload %s lacks creator information.',
            messageParams: [upload.name],
            userMessage: 'upload needs creator'
          });

        upload.source = getVal(formValues.sources);

        if (!upload.source || !upload.source[language])
          throw new ReportedError({
            message: 'Form data for upload %s lacks source information.',
            messageParams: [upload.name],
            userMessage: 'upload needs source'
          });

        upload.license = getVal(formValues.licenses);

        if (!upload.license)
          throw new ReportedError({
            message: 'Form data for upload %s lacks license information.',
            messageParams: [upload.name],
            userMessage: 'upload needs license'
          });

      } else if (by === 'uploader') {
        upload.license = 'cc-by-sa';
      } else {
        throw new ReportedError({
          message: 'Upload form contained unexpected form data.',
          userMessage: 'unexpected form data'
        });
      }
      completeUploadPromises.push(completeUpload(upload));
    });

    await Promise.all(completeUploadPromises);
}

async function completeUpload(upload) {
  // File names are sanitized on input but ..
  // This error is not shown to the user but logged, hence native.
  if (!upload.name || /[/<>]/.test(upload.name))
    throw new Error(`Invalid filename: ${upload.name}`);

  // Move the file to its final location so it can be served
  let oldPath = path.join(config.uploadTempDir, upload.name),
    newPath = path.join(__dirname, '../static/uploads', upload.name);

  await rename(oldPath, newPath);
  upload.completed = true;
  try {
    await upload.save();
  } catch (error) {
    // Problem saving the metadata. Move upload back to
    // temporary stash.
    await rename(newPath, oldPath);
  }
}

/**
 * Move a set of uploads to their final location and set the "completed"
 * property to true.
 *
 * @param  {File[]} fileRevs
 *  uploads to complete
 * @returns {File[]}
 * @memberof Uploads
 */
async function completeUploads(fileRevs) {
  for (let fileRev of fileRevs)
    await completeUpload(fileRev);
  return fileRevs;
}

function assignFilename(req, file, done) {
  let p = path.parse(file.originalname);
  let name = `${p.name}-${Date.now()}${p.ext}`;
  name.replace(/<>&/g, '');
  done(null, name);
}

export {
  stage1Router,
  stage2Router,
  checkMIMEType,
  cleanupFiles,
  validateFiles,
  getFileRevs,
  assignFilename,
  completeUpload,
  completeUploads
};
