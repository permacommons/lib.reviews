import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Router } from 'express';

import File from '../models/file.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import getResourceErrorHandler from './handlers/resource-error-handler.ts';
import render from './helpers/render.ts';

type FilesRouteRequest<Params extends Record<string, string> = Record<string, string>> =
  HandlerRequest<Params>;
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

router.get('/files', (req: FilesRouteRequest, res: FilesRouteResponse, next: HandlerNext) => {
  FileModel.getFileFeed()
    .then(feed => showFiles(req, res, feed))
    .catch(next);
});

router.get(
  '/files/before/:utcisodate',
  (req: FilesRouteRequest<{ utcisodate: string }>, res: FilesRouteResponse, next: HandlerNext) => {
    let utcISODate = req.params.utcisodate;
    let offsetDate = new Date(utcISODate);
    if (Number.isNaN(offsetDate.getTime())) offsetDate = null;

    FileModel.getFileFeed({ offsetDate })
      .then(feed => showFiles(req, res, feed))
      .catch(next);
  }
);

function showFiles(req: FilesRouteRequest, res: FilesRouteResponse, feed: Record<string, any>) {
  feed.items.forEach(file => file.populateUserInfo(req.user));
  render.template(req, res, 'files', {
    titleKey: 'uploaded files title',
    files: feed.items,
    paginationURL: feed.offsetDate ? `/files/before/${feed.offsetDate.toISOString()}` : null,
    singleColumn: true,
  });
}

router.get(
  '/file/:id/delete',
  (req: FilesRouteRequest<{ id: string }>, res: FilesRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    FileModel.getNotStaleOrDeleted(id)
      .then(file => {
        const titleKey = 'delete file';
        file.populateUserInfo(req.user);
        if (!file.userCanDelete) return render.permissionError(req, res, { titleKey });

        render.template(req, res, 'delete-file', {
          file,
          titleKey,
          singleColumn: true,
        });
      })
      .catch(getResourceErrorHandler(req, res, next, 'file', id));
  }
);

router.post(
  '/file/:id/delete',
  (req: FilesRouteRequest<{ id: string }>, res: FilesRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    FileModel.getNotStaleOrDeleted(id)
      .then(file => {
        const titleKey = 'file deleted';
        file.populateUserInfo(req.user);
        if (!file.userCanDelete) return render.permissionError(req, res, { titleKey });

        deleteFile(req, file, req.user)
          .then(() => {
            render.template(req, res, 'file-deleted', {
              file,
              titleKey,
            });
          })
          .catch(next);
      })
      .catch(getResourceErrorHandler(req, res, next, 'file', id));
  }
);

async function deleteFile(
  req: FilesRouteRequest,
  file: Record<string, any>,
  user: Record<string, any>
) {
  const { uploadsDir, deletedDir } = req.app.locals.paths as {
    uploadsDir: string;
    deletedDir: string;
  };

  const oldPath = path.join(uploadsDir, file.name);
  const newPath = path.join(deletedDir, file.name);

  await file.deleteAllRevisions(user);
  await rename(oldPath, newPath);
}

export default router;
