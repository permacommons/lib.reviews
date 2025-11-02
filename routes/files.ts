import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import File from '../models/file.ts';
import getResourceErrorHandler from './handlers/resource-error-handler.ts';
import render from './helpers/render.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';

type FilesRouteRequest<Params extends Record<string, string> = Record<string, string>> = HandlerRequest<Params>;
type FilesRouteResponse = HandlerResponse;
type FileModelType = {
  getFileFeed(options?: Record<string, unknown>): Promise<Record<string, any>>;
  getNotStaleOrDeleted(id: string): Promise<Record<string, any>>;
};

const router = Router();
const FileModel = File as unknown as FileModelType;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rename = promisify(fs.rename);

router.get('/files', function(req: FilesRouteRequest, res: FilesRouteResponse, next: HandlerNext) {
  FileModel.getFileFeed()
    .then(feed => showFiles(req, res, feed))
    .catch(next);
});

router.get('/files/before/:utcisodate', function(req: FilesRouteRequest<{ utcisodate: string }>, res: FilesRouteResponse, next: HandlerNext) {
  let utcISODate = req.params.utcisodate;
  let offsetDate = new Date(utcISODate);
  if (Number.isNaN(offsetDate.getTime()))
    offsetDate = null;

  FileModel.getFileFeed({ offsetDate })
    .then(feed => showFiles(req, res, feed))
    .catch(next);
});

function showFiles(req: FilesRouteRequest, res: FilesRouteResponse, feed: Record<string, any>) {
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

router.get('/file/:id/delete', function(req: FilesRouteRequest<{ id: string }>, res: FilesRouteResponse, next: HandlerNext) {
  const { id } = req.params;
  FileModel
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

router.post('/file/:id/delete', function(req: FilesRouteRequest<{ id: string }>, res: FilesRouteResponse, next: HandlerNext) {
  const { id } = req.params;
  FileModel
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

async function deleteFile(file: Record<string, any>, user: Record<string, any>) {
  const oldPath = path.join(__dirname, '../static/uploads', file.name);
  const newPath = path.join(__dirname, '../deleted', file.name);

  await file.deleteAllRevisions(user);
  await rename(oldPath, newPath);
}

export default router;
