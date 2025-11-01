import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import File from '../models/file.js';
import getResourceErrorHandler from './handlers/resource-error-handler.js';
import render from './helpers/render.ts';

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rename = promisify(fs.rename);

router.get('/files', function(req, res, next) {
  File.getFileFeed()
    .then(feed => showFiles(req, res, feed))
    .catch(next);
});

router.get('/files/before/:utcisodate', function(req, res, next) {
  let utcISODate = req.params.utcisodate;
  let offsetDate = new Date(utcISODate);
  if (!offsetDate || offsetDate == 'Invalid Date')
    offsetDate = null;

  File.getFileFeed({ offsetDate })
    .then(feed => showFiles(req, res, feed))
    .catch(next);
});

function showFiles(req, res, feed) {
  feed.items.forEach(file => file.populateUserInfo(req.user));
  render.template(req, res, 'files', {
    titleKey: 'uploaded files title',
    files: feed.items,
    paginationURL: feed.offsetDate ?
      `/files/before/${feed.offsetDate.toISOString()}` :
       null,
    singleColumn: true
  });
}

router.get('/file/:id/delete', function(req, res, next) {
  const { id } = req.params;
  File
    .getNotStaleOrDeleted(id)
    .then(file => {
      const titleKey = 'delete file';
      file.populateUserInfo(req.user);
      if (!file.userCanDelete)
        return render.permissionError(req, res, { titleKey });

      render.template(req, res, 'delete-file', {
        file,
        titleKey,
        singleColumn: true
      });
    })
    .catch(getResourceErrorHandler(req, res, next, 'file', id));
});

router.post('/file/:id/delete', function(req, res, next) {
  const { id } = req.params;
  File
    .getNotStaleOrDeleted(id)
    .then(file => {
      const titleKey = 'file deleted';
      file.populateUserInfo(req.user);
      if (!file.userCanDelete)
        return render.permissionError(req, res, { titleKey });

      deleteFile(file, req.user)
        .then(() => {
          render.template(req, res, 'file-deleted', {
            file,
            titleKey
          });
        })
        .catch(next);
    })
    .catch(getResourceErrorHandler(req, res, next, 'file', id));
});

async function deleteFile(file, user) {
  const oldPath = path.join(__dirname, '../static/uploads', file.name);
  const newPath = path.join(__dirname, '../deleted', file.name);

  await file.deleteAllRevisions(user);
  await rename(oldPath, newPath);
}

export default router;
