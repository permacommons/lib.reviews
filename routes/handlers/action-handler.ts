import config from 'config';
import multer from 'multer';
import is from 'type-is';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import api from '../helpers/api.ts';
import render from '../helpers/render.ts';
import { assignFilename, checkMIMEType } from '../uploads.ts';
import apiUploadHandler, { type UploadMetadata } from './api-upload-handler.ts';

type UploadFile = {
  originalname: string;
  filename: string;
  mimetype?: string;
  [key: string]: unknown;
};

type ActionResponse = HandlerResponse;

type PreferenceRequest = HandlerRequest<
  { modify?: string },
  unknown,
  { preferenceName?: string; value?: string }
>;

type NoticeRequest = HandlerRequest<Record<string, string>, unknown, { noticeType?: string }>;

type UploadRequest = HandlerRequest<Record<string, string>, unknown, UploadMetadata> & {
  files: UploadFile[];
};

type UploadMiddleware = (req: UploadRequest, res: ActionResponse, next: HandlerNext) => void;

const actionHandler = {
  // Handler for enabling, disabling, toggling, or setting user preferences.
  // For boolean preferences: use enable, disable, or toggle actions
  // For enum preferences: use set action with a value parameter
  modifyPreference(req: PreferenceRequest, res: ActionResponse, next: HandlerNext): void {
    const user = req.user;
    const preferenceName = String(req.body?.preferenceName ?? '').trim();
    const modifyAction = String(req.params?.modify ?? '');
    const value = req.body?.value !== undefined ? String(req.body.value).trim() : undefined;

    if (!user) return api.signinRequired(req, res);

    const validPrefs = user.getValidPreferences();
    if (!validPrefs.includes(preferenceName))
      return api.error(req, res, `Unknown preference: ${preferenceName}`);

    // Map API preference names to model property names
    const prefPropertyMap: Record<string, string> = {
      theme: 'themePreference',
    };
    const propertyName = prefPropertyMap[preferenceName] || preferenceName;

    let message: string;
    const oldValue = user[propertyName] === undefined ? 'not set' : String(user[propertyName]);
    switch (modifyAction) {
      case 'enable':
        user[propertyName] = true;
        break;
      case 'disable':
        user[propertyName] = false;
        break;
      case 'toggle':
        user[propertyName] = !user[propertyName];
        break;
      case 'set':
        if (value === undefined) {
          return api.error(req, res, 'Missing value parameter for set action');
        }
        // Validate enum values for specific preferences
        if (preferenceName === 'theme') {
          if (!['light', 'dark', 'system'].includes(value)) {
            return api.error(
              req,
              res,
              `Invalid theme value: ${value}. Must be light, dark, or system.`
            );
          }
        }
        user[propertyName] = value;
        break;
      default:
        return api.error(req, res, `Unknown preference action: ${modifyAction}`);
    }
    const newValue = String(user[propertyName]);
    message = oldValue === newValue ? 'Preference not altered.' : 'Preference changed.';

    const savePromise = typeof user.save === 'function' ? user.save() : Promise.resolve();
    savePromise
      .then(() => {
        res.status(200);
        res.type('json');
        res.send(
          JSON.stringify(
            {
              message,
              oldValue,
              newValue,
              errors: [],
            },
            null,
            2
          )
        );
      })
      .catch(next);
  },
  // Handler for hiding interface messages, announcements, etc., permanently for a given user
  suppressNotice(req: NoticeRequest, res: ActionResponse, next: HandlerNext): void {
    const noticeType = String(req.body?.noticeType ?? '').trim();
    const user = req.user;
    const output = req.isAPI ? api : render;
    if (!user) return output.signinRequired(req, res);

    switch (noticeType) {
      case 'language-notice-review':
      case 'language-notice-thing': {
        if (!user.suppressedNotices) user.suppressedNotices = [noticeType];
        else if (user.suppressedNotices.indexOf(noticeType) === -1)
          user.suppressedNotices.push(noticeType);

        const savePromise = typeof user.save === 'function' ? user.save() : Promise.resolve();
        savePromise
          .then(() => {
            if (req.isAPI) {
              const response: Record<string, unknown> = {};
              response.message = `Success. Messages of type "${noticeType}" will no longer be shown.`;
              response.errors = [];
              res.type('json');
              res.status(200);
              res.send(JSON.stringify(response, null, 2));
            } else {
              render.template(req, res, 'notice-suppressed', {
                titleKey: 'notice suppressed',
                noticeMessage: req.__(`notice type ${noticeType}`),
              });
            }
          })
          .catch(next);
        break;
      }

      default:
        if (req.isAPI) {
          const response: Record<string, unknown> = {};
          response.message = 'The request could not be processed.';
          response.errors = [`The given notice type, ${noticeType}, was not recognized.`];
          res.type('json');
          res.status(400);
          res.send(JSON.stringify(response, null, 2));
        } else {
          render.template(req, res, 'unsupported-notice', {
            titleKey: 'unsupported notice',
            noticeType,
          });
        }
    }
  },

  /**
   * Handle a multipart API upload. API parameters
   *
   * - files: holds the file or file
   * - multiple: (true if truthy) if we want to process just one file, or
   *   multiple files
   * - description, author, source, license, language, ownwork: file metadata
   *
   * If ownwork is truthy, author and source must not be present.
   *
   * If uploading multiple files, add filename to each parameter, e.g.:
   * license-foo.jpg
   *
   * @param req
   *  Express request
   * @param res
   *  Express response
   * @param next
   *  callback to next middleware
   */
  upload(req: UploadRequest, res: ActionResponse, next: HandlerNext): void {
    if (!is(req, ['multipart'])) {
      next();
      return;
    }

    if (!req.user) {
      api.signinRequired(req, res);
      return;
    }

    if (!req.user.userCanUploadTempFiles && !req.user.isTrusted && !req.user.isSuperUser) {
      api.error(req, res, `User '${req.user.displayName}' is not permitted to upload files.`);
      return;
    }

    const performUpload: UploadMiddleware = multer({
      limits: {
        fileSize: config.uploadMaxSize,
      },
      storage: multer.diskStorage({
        destination: config.uploadTempDir,
        filename: assignFilename,
      }),
      fileFilter: (_req, file, done) => {
        const { fileTypeError, isPermitted } = checkMIMEType(file);
        done(fileTypeError, isPermitted);
      },
    }).array('files') as UploadMiddleware;

    // Execute the actual upload middleware
    performUpload(req, res, apiUploadHandler(req, res));
  },
};

export default actionHandler;
