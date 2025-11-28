/**
 * Process uploads via the web (provides general functions shared by the API).
 *
 * @namespace Uploads
 */

import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import config from 'config';
import escapeHTML from 'escape-html';
import { Router } from 'express';
import isSVG from 'is-svg';
import type { FileFilterCallback } from 'multer';
import multer from 'multer';
import is from 'type-is';
import { type ZodIssue, z } from 'zod';
import languages from '../locales/languages.ts';
import type { FileInstance } from '../models/file.ts';
import File from '../models/file.ts';
import type { ThingInstance } from '../models/manifests/thing.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import {
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError,
} from '../util/csrf.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import getResourceErrorHandler from './handlers/resource-error-handler.ts';
import render from './helpers/render.ts';
import slugs from './helpers/slugs.ts';
import { flashZodIssues, formatZodIssueMessage } from './helpers/zod-flash.ts';
import { coerceString, requiredTrimmedString } from './helpers/zod-forms.ts';

const readFile = promisify(fs.readFile);
const rename = promisify(fs.rename);
const unlink = promisify(fs.unlink);
type UploadsRequest<Params extends Record<string, string> = Record<string, string>> =
  HandlerRequest<Params>;
type UploadsResponse = HandlerResponse;
type UploadedFile = {
  originalname: string;
  filename: string;
  mimetype?: string;
  path?: string;
  size?: number;
  [key: string]: unknown;
};

// Uploading is a two step process. In the first step, the user simply posts the
// file or files. In the second step, they provide information such as the
// license and description. This first step has to be handled prior to the CSRF
// middleware because of the requirement of managing upload streams and
// multipart forms.
//
// Whether or not an upload is finished, as long as we have a valid file, we
// keep it on disk, initially in a temporary directory. We also create a
// record in the "files" table for it that can be completed later.
const stage1Router = Router();
const stage2Router = Router();

let fileTypeFromFileFn;
async function detectFileType(filePath) {
  if (!fileTypeFromFileFn) {
    ({ fileTypeFromFile: fileTypeFromFileFn } = await import('file-type'));
  }
  return fileTypeFromFileFn(filePath);
}

const allowedTypes = [
  'image/png',
  'image/gif',
  'image/svg+xml',
  'image/jpeg',
  'image/webp',
  'video/webm',
  'video/ogg',
  'audio/ogg',
  'audio/mpeg',
];

type UploadMetadata = {
  by: 'uploader' | 'other';
  description: Record<string, string>;
  creator?: Record<string, string>;
  source?: Record<string, string>;
  license: string;
};

type ParsedUploadForm = {
  uploads: Record<string, UploadMetadata>;
  language: string;
};

type UploadFormValues = {
  by: 'uploader' | 'other';
  description: string;
  creator?: string;
  source?: string;
  license?: string;
};

const toUploadRecord = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function buildUploadMetadataSchema(req: UploadsRequest): z.ZodType<ParsedUploadForm> {
  const translate = req.__.bind(req);

  const uploadLanguageField = z
    .string()
    .trim()
    .superRefine((language, ctx) => {
      try {
        languages.validate(language);
      } catch (_error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upload-language'],
          message: 'invalid language code',
        });
      }
    });

  const uploadEntrySchema = z
    .object({
      description: requiredTrimmedString('upload needs description'),
      by: z.enum(['uploader', 'other']),
      creator: z.preprocess(coerceString, z.string().trim().optional()),
      source: z.preprocess(coerceString, z.string().trim().optional()),
      license: z.preprocess(coerceString, z.string().trim().optional()),
    })
    .passthrough()
    .superRefine((data, ctx) => {
      if (data.by !== 'other') return;

      if (!data.creator?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['creator'],
          message: 'upload needs creator',
        });
      }
      if (!data.source?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source'],
          message: 'upload needs source',
        });
      }
      if (!data.license?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['license'],
          message: 'upload needs license',
        });
      }
    });

  return z
    .object({
      _csrf: z.string().min(1, translate('need _csrf')),
      'upload-language': uploadLanguageField,
      upload: z.preprocess(toUploadRecord, z.record(z.string(), uploadEntrySchema)),
    })
    .passthrough()
    .superRefine((data, ctx) => {
      if (!Object.keys(data.upload ?? {}).length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upload'],
          message: 'data missing',
        });
      }
    })
    .transform(({ upload, 'upload-language': language }) => {
      const toMultilingual = (value: string) => ({
        [language]: escapeHTML(value.trim()),
      });

      const uploads = Object.fromEntries(
        Object.entries(upload).map(([id, entry]) => {
          // Keep raw message keys on issues and translate later so we can substitute the filename.
          const normalized: UploadMetadata = {
            by: entry.by,
            description: toMultilingual(entry.description),
            license: entry.by === 'uploader' ? 'cc-by-sa' : (entry.license ?? '').trim(),
          };

          if (entry.by === 'other') {
            normalized.creator = toMultilingual(entry.creator ?? '');
            normalized.source = toMultilingual(entry.source ?? '');
          }

          return [id, normalized];
        })
      );

      return {
        uploads,
        language,
      };
    });
}

// You can upload multiple uploads in one batch; this form is used to process
// the metadata. With qs bracket notation, the entire upload object is parsed
// as a nested structure, so we just need to accept the top-level 'upload' key.

stage1Router.post(
  '/:id/upload',
  (req: UploadsRequest<{ id: string }>, res: UploadsResponse, next: HandlerNext) => {
    // On to stage 2
    if (!is(req, ['multipart'])) return next();

    let id = req.params.id.trim();
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(thing => {
        thing.populateUserInfo(req.user);
        if (!thing.userCanUpload)
          return render.permissionError(req, res, {
            titleKey: 'add media',
          });

        let storage = multer.diskStorage({
          destination: config.uploadTempDir,
          filename: assignFilename,
        });

        let upload = multer({
          limits: {
            fileSize: config.uploadMaxSize,
          },
          fileFilter: getFileFilter(req, res),
          storage,
        }).array('media');

        // Execute the actual upload middleware
        upload(req, res, getUploadHandler(req, res, next, thing));
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

stage2Router.post(
  '/:id/upload',
  (req: UploadsRequest<{ id: string }>, res: UploadsResponse, next: HandlerNext) => {
    let id = req.params.id.trim();
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(thing => {
        thing.populateUserInfo(req.user);
        if (!thing.userCanUpload)
          return render.permissionError(req, res, {
            titleKey: 'add media',
          });

        processUploadForm(req, res, next, thing);
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

/**
 * Create a Multer file filter bound to the current request and response.
 * Validates candidate files against permitted MIME types, producing an
 * error for unsupported types and allowing permitted ones to proceed.
 *
 * @param req Request object for the upload route context
 * @param res Response object for the upload route context
 * @returns A Multer FileFilter callback that enforces permitted types
 */
function getFileFilter(req: UploadsRequest<{ id: string }>, res: UploadsResponse) {
  return (_req: UploadsRequest, file: UploadedFile, done: FileFilterCallback) => {
    const { fileTypeError, isPermitted } = checkMIMEType(file);
    return done(fileTypeError as Error | null, isPermitted);
  };
}

/**
 * Check whether a file's reported MIME type is permitted for upload.
 * This does not validate the file contents—only the claimed type.
 *
 * @param file Uploaded file metadata (original name, mimetype, etc.)
 * @returns Object indicating any validation error and whether the file is permitted
 */
function checkMIMEType(file: UploadedFile): { fileTypeError: Error | null; isPermitted: boolean } {
  if (!allowedTypes.includes(file.mimetype))
    return {
      fileTypeError: new ReportedError({
        userMessage: 'unsupported file type',
        userMessageParams: [file.originalname, file.mimetype],
      }),
      isPermitted: false,
    };
  else
    return {
      fileTypeError: null,
      isPermitted: true,
    };
}

// Checks validity of the files and, if appropriate, performs the actual upload
function getUploadHandler(
  req: UploadsRequest<{ id: string }>,
  res: UploadsResponse,
  next: HandlerNext,
  thing: ThingInstance
) {
  return (error?: unknown) => {
    const uploadRequest = req as UploadsRequest<{ id: string }> & {
      files?: UploadedFile[];
      flashError?: (error: unknown) => void;
    };

    const abortUpload = (uploadError: unknown) => {
      // Async, but we don't wait for completion. Note that multer performs
      // its own cleanup on fileFilter errors, and req.files will be an empty
      // array in that case.
      cleanupFiles(uploadRequest);
      uploadRequest.flashError?.(uploadError);
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
    if (error) return abortUpload(error);

    const files = uploadRequest.files ?? [];
    if (files.length) {
      const user = uploadRequest.user;
      if (!user) {
        abortUpload(new Error('User required for upload.'));
        return;
      }

      validateFiles(files)
        .then(fileTypes => getFileRevs(files, fileTypes, user, ['upload', 'upload-via-form']))
        .then(fileRevs => attachFileRevsToThing(fileRevs, thing))
        .then(uploadedFiles =>
          render.template(req, res, 'thing-upload-step-2', {
            titleKey: 'add media',
            thing,
            uploadedFiles,
            csrfToken: generateToken(req),
          })
        )
        .catch(abortUpload);
    } else {
      req.flash('pageErrors', req.__('no file received'));
      res.redirect(`/${thing.urlID}`);
    }
  };
}

/**
 * Validate a batch of uploaded files for correctness and safety.
 * Uses magic-number detection for most types and specialized checks for SVG.
 *
 * @param files Array of uploaded file descriptors to validate
 * @returns Resolved MIME types for each file (aligned by index)
 */
async function validateFiles(files: UploadedFile[]): Promise<string[]> {
  const validators: Promise<string>[] = [];
  files.forEach(file => {
    const filePath = typeof file.path === 'string' ? file.path : '';
    // SVG files need full examination
    if (!filePath) {
      validators.push(
        Promise.reject(
          new ReportedError({
            userMessage: 'unrecognized file type',
            userMessageParams: [file.originalname],
          })
        )
      );
    } else if (file.mimetype != 'image/svg+xml')
      validators.push(validateFile(filePath, file.mimetype));
    else validators.push(validateSVG(filePath));
  });
  const fileTypes = await Promise.all(validators);
  return fileTypes;
}

/**
 * Create initial File model revisions for each uploaded file and populate
 * core metadata (name, MIME type, uploader, timestamps), optionally tagging
 * each revision for audit/traceability.
 *
 * @param files Files received from the client
 * @param fileTypes Validated MIME types corresponding to each file
 * @param user Authenticated user responsible for the upload
 * @param tags Optional tags applied to each created file revision
 * @returns Array of File revisions ready to be associated to a Thing
 */
async function getFileRevs(
  files: UploadedFile[],
  fileTypes: string[],
  user: Express.User,
  tags: string[] = []
): Promise<FileInstance[]> {
  const fileRevs = await Promise.all(files.map(() => File.createFirstRevision(user, { tags })));
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

async function attachFileRevsToThing(
  fileRevs: FileInstance[],
  thing: ThingInstance
): Promise<FileInstance[]> {
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

/**
 * Remove any temporarily staged files associated with the current request.
 * Intended for early-abort paths (e.g., CSRF failure or filter error),
 * this function ensures disk cleanup for partially processed uploads.
 *
 * @param req Request object that may contain a files array
 * @returns Nothing; resolves once cleanup attempts are complete
 */
async function cleanupFiles(req: UploadsRequest & { files?: UploadedFile[] }): Promise<void> {
  if (!Array.isArray(req.files) || !req.files?.length) return;

  try {
    await Promise.all(
      req.files.filter(file => typeof file.path === 'string').map(file => unlink(String(file.path)))
    );
  } catch (error) {
    debug.error({ error, req });
  }
}

// Verify that a file's contents match its claimed MIME type. This is shallow,
// fast validation. If files are manipulated, we need to pay further attention
// to any possible exploits.
async function validateFile(filePath: string, claimedType: string | undefined): Promise<string> {
  if (!filePath)
    throw new ReportedError({
      userMessage: 'unrecognized file type',
      userMessageParams: [''],
    });
  const type = await detectFileType(filePath);

  // Browser sometimes misreports media type for Ogg files. We don't throw an
  // error in this case, but return the correct type.
  const allOgg = (...types) => types.every(type => /\/ogg$/.test(type));

  if (!type)
    throw new ReportedError({
      userMessage: 'unrecognized file type',
      userMessageParams: [path.basename(filePath)],
    });
  else if (type.mime !== claimedType && !allOgg(type.mime, claimedType ?? ''))
    throw new ReportedError({
      userMessage: 'mime mismatch',
      userMessageParams: [path.basename(filePath), claimedType, type.mime],
    });
  else return type.mime;
}

/**
 * Perform a shallow validation that a file contains SVG data.
 * Reads the file and checks content using an SVG detector.
 *
 * @param filePath Path to the staged file on disk
 * @returns The canonical MIME type string for SVG when valid
 */
async function validateSVG(filePath: string): Promise<string> {
  if (!filePath)
    throw new ReportedError({
      userMessage: 'unrecognized file type',
      userMessageParams: [''],
    });
  const data = await readFile(filePath);
  if (isSVG(data)) return 'image/svg+xml';
  else
    throw new ReportedError({
      userMessage: 'not valid svg',
      userMessageParams: [path.basename(filePath)],
    });
}

// If an upload is unfinished, it can still be viewed at its destination URL
// by the user who uploaded it.
stage1Router.get(
  '/static/uploads/restricted/:name',
  (req: UploadsRequest<{ name: string }>, res: UploadsResponse, next: HandlerNext) => {
    if (!req.user) return next();

    const userIDValue = req.user.id;
    const userID =
      typeof userIDValue === 'string'
        ? userIDValue
        : typeof userIDValue === 'number'
          ? String(userIDValue)
          : null;

    if (!userID) return next();

    File.getStashedUpload(userID, req.params.name)
      .then(upload => {
        if (!upload) return next();
        res.sendFile(path.join(config.uploadTempDir, upload.name));
      })
      .catch(next);
  }
);

function processUploadForm(
  req: UploadsRequest<{ id: string }>,
  res: UploadsResponse,
  _next: HandlerNext,
  thing: ThingInstance
) {
  const rawUploads = toUploadRecord(req.body?.upload);
  const uploadIDs = Object.keys(rawUploads);

  // Preserve user-entered values so a failed validation can re-render the form with data intact.
  const getSubmittedValues = (): Record<string, UploadFormValues> =>
    Object.fromEntries(
      Object.entries(rawUploads).map(([id, value]) => {
        const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const by = record.by === 'other' ? 'other' : 'uploader';
        return [
          id,
          {
            by,
            description: coerceString(record.description),
            creator: coerceString(record.creator),
            source: coerceString(record.source),
            license: coerceString(record.license),
          },
        ];
      })
    );

  const redirectBack = ({ message, error }: { message?: unknown[]; error?: unknown[] } = {}) => {
    if (Array.isArray(error)) {
      const [key, ...params] = error as [string, ...unknown[]];
      const strParams = params.map(p => String(p));
      req.flash('pageErrors', req.__(key, ...strParams));
    }
    if (Array.isArray(message)) {
      const [key, ...params] = message as [string, ...unknown[]];
      const strParams = params.map(p => String(p));
      req.flash('pageMessages', req.__(key, ...strParams));
    }

    res.redirect(`/${thing.urlID}`);
  };

  const renderUploadForm = async (options: {
    uploadedFiles?: FileInstance[];
    pageErrors?: string[];
    formValues?: Record<string, UploadFormValues>;
    uploadLanguage?: string;
    issues?: ZodIssue[];
  }) => {
    const uploadedFiles =
      options.uploadedFiles ??
      (
        await Promise.all(
          uploadIDs.map(async id => {
            try {
              return await File.getNotStaleOrDeleted(id);
            } catch (error) {
              debug.error({ error, req });
              return null;
            }
          })
        )
      ).filter((file): file is FileInstance => Boolean(file));

    if (!uploadedFiles.length) return redirectBack({ error: ['data missing'] });

    // Rebuild the page with the staged uploads, flashed/derived errors, and the user's inputs.
    const uploadNames = Object.fromEntries(uploadedFiles.map(file => [file.id, file.name]));
    const uploadLanguage = options.uploadLanguage ?? coerceString(req.body?.['upload-language']);
    const formValues = options.formValues ?? getSubmittedValues();
    const pageErrors =
      options.pageErrors ??
      (options.issues
        ? options.issues.map(issue => {
            // Build localized errors at render-time to inject the specific filename into the message.
            if (
              Array.isArray(issue.path) &&
              issue.path[0] === 'upload' &&
              typeof issue.path[1] === 'string'
            ) {
              const uploadName = uploadNames[issue.path[1]] ?? issue.path[1];
              return req.__(issue.message, uploadName);
            }
            if (
              Array.isArray(issue.path) &&
              issue.path[0] === 'upload-language' &&
              issue.message === 'invalid language code'
            ) {
              return req.__(issue.message, uploadLanguage);
            }
            return formatZodIssueMessage(req, issue, 'unexpected form data');
          })
        : req.flash('pageErrors'));

    return render.template(
      req,
      res,
      'thing-upload-step-2',
      {
        titleKey: 'add media',
        thing,
        uploadedFiles,
        csrfToken: generateToken(req),
        pageErrors,
        formValues,
        uploadLanguage,
      },
      {
        messages: {
          'one file selected': req.__('one file selected'),
          'files selected': req.__('files selected'),
        },
      }
    );
  };

  const parseResult = buildUploadMetadataSchema(req).safeParse(req.body);
  if (!parseResult.success) {
    return renderUploadForm({
      issues: parseResult.error.issues,
      formValues: getSubmittedValues(),
      uploadLanguage: coerceString(req.body?.['upload-language']),
    });
  }

  const parsedUploadIDs = Object.keys(parseResult.data.uploads);
  if (!parsedUploadIDs.length) return redirectBack({ error: ['data missing'] });

  const getFiles = async (ids: string[]) =>
    await Promise.all(ids.map(id => File.getNotStaleOrDeleted(id)));

  // Load file info from stage 1 using the upload IDs from the form. Parse the
  // form and abort if there's a problem with any given upload. If there's no
  // problem, move the upload to its final location, update its metadata and
  // mark it as finished.
  getFiles(parsedUploadIDs)
    .then(files => processUploads(files, parseResult.data.uploads, req.app.locals.paths.uploadsDir))
    .then(() => redirectBack({ message: ['upload completed'] }))
    .catch(async error => {
      req.flashError?.(error);
      const pageErrors = req.flash?.('pageErrors') ?? [];
      if (pageErrors.length) {
        return renderUploadForm({
          pageErrors,
          formValues: getSubmittedValues(),
          uploadLanguage: parseResult.data.language,
        });
      }
      redirectBack();
    });
}

async function processUploads(
  uploads: FileInstance[],
  uploadData: Record<string, UploadMetadata>,
  uploadsDir: string
): Promise<void> {
  let completeUploadPromises: Promise<unknown>[] = [];

  uploads.forEach(upload => {
    const data = uploadData[upload.id];
    if (!data) {
      throw new ReportedError({
        message: 'Form data missing for upload %s.',
        messageParams: [upload.name],
        userMessage: 'data missing',
      });
    }

    upload.description = data.description;

    if (data.by === 'other') {
      upload.creator = data.creator;
      upload.source = data.source;
    }
    upload.license = data.license;
    completeUploadPromises.push(completeUpload(upload, uploadsDir));
  });

  await Promise.all(completeUploadPromises);
}

/**
 * Move a staged upload to its final public location and mark it complete.
 * Ensures safe filenames, performs the move, and persists metadata.
 * If persistence fails, the file is moved back to the staging area.
 *
 * @param upload Upload revision to finalize
 * @param uploadsDir Destination directory for completed uploads
 * @returns Nothing; resolves once the upload is finalized or rolled back
 */
async function completeUpload(upload: FileInstance, uploadsDir: string): Promise<void> {
  // File names are sanitized on input but ..
  // This error is not shown to the user but logged, hence native.
  if (!upload.name || /[/<>]/.test(upload.name))
    throw new Error(`Invalid filename: ${upload.name}`);

  // Move the file to its final location so it can be served
  const oldPath = path.join(config.uploadTempDir, upload.name);
  const newPath = path.join(uploadsDir, upload.name);

  await rename(oldPath, newPath);
  upload.completed = true;
  try {
    await upload.save();
  } catch (error) {
    // Problem saving the metadata. Move upload back to
    // temporary stash.
    await rename(newPath, oldPath);
    throw error;
  }
}

/**
 * Move a set of uploads to their final location and set the "completed"
 * property to true.
 *
 * @param fileRevs Upload revisions to complete
 * @param uploadsDir Destination directory for completed uploads
 * @returns The same uploads after being finalized
 */
async function completeUploads(
  fileRevs: FileInstance[],
  uploadsDir: string
): Promise<FileInstance[]> {
  for (let fileRev of fileRevs) await completeUpload(fileRev, uploadsDir);
  return fileRevs;
}

/**
 * Generate a sanitized, unique filename for a freshly uploaded file by
 * appending a timestamp to the original name while preserving the extension.
 *
 * @param _req Request object (unused)
 * @param file Uploaded file descriptor containing the original name
 * @param done Multer callback invoked with the generated filename
 */
function assignFilename(
  _req: UploadsRequest,
  file: UploadedFile,
  done: (error: Error | null, filename?: string) => void
) {
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
  completeUploads,
};
