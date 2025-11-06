// External dependencies
import type { Request, Response } from 'express';
import isUUID from 'is-uuid';

// Internal dependencies
import errors from '../../dal/lib/errors.ts';
import Team from '../../models/team.ts';
import Thing from '../../models/thing.ts';
import ThingSlug from '../../models/thing-slug.ts';

const { DocumentNotFound } = errors;

type LoadOptions = Record<string, unknown> | undefined;

type DocumentModel = {
  getWithData: (id: string, options?: LoadOptions) => Promise<any>;
};

type SlugModel = {
  get?: (name: string) => Promise<{ name: string; [key: string]: unknown } | null>;
  getByName?: (name: string) => Promise<{ name: string; [key: string]: unknown } | null>;
};

interface ModelConfig {
  basePath: string;
  slugForeignKey: string;
  slugLabel: string;
  getDocumentModel?: () => DocumentModel | Promise<DocumentModel>;
  DocumentModel?: DocumentModel;
  loadSlug?: (
    slugName: string,
    model: DocumentModel
  ) => Promise<{ name: string; [key: string]: unknown } | null>;
  slugModel?: SlugModel;
  SlugModel?: SlugModel;
}

let teamSlugModulePromise: Promise<typeof import('../../models/team-slug.ts')> | null = null;
async function getTeamSlugModel() {
  if (!teamSlugModulePromise) teamSlugModulePromise = import('../../models/team-slug.ts');
  const module = await teamSlugModulePromise;
  return module.default;
}

/**
 * Resolve a team's slug or ID and load it with the supplied options. Rejects
 * when the team cannot be found or the request is redirected.
 *
 * @param req
 *  Request object used for redirect handling
 * @param res
 *  Response used for redirects
 * @param id
 *  Slug or UUID for the team
 * @param loadOptions
 *  Options documented on the Team model's `getWithData`
 */
const resolveAndLoadTeam = (req: Request, res: Response, id: string, loadOptions?: LoadOptions) =>
  resolveAndLoad(req, res, id, loadOptions, {
    basePath: '/team/',
    slugForeignKey: 'teamID',
    getDocumentModel: async () => Team as unknown as DocumentModel,
    loadSlug: async (slugName: string, _model: DocumentModel) => {
      const TeamSlugModel = await getTeamSlugModel();
      if (!TeamSlugModel || typeof TeamSlugModel.getByName !== 'function') return null;
      // TeamSlug returns model instances; convert to a plain object that exposes
      // exactly the fields resolveAndLoad expects (notably `name`).
      const slugRecord = await TeamSlugModel.getByName(slugName);
      if (!slugRecord || typeof slugRecord !== 'object') {
        return null;
      }
      const { name, ...rest } = slugRecord as Record<string, unknown>;
      if (typeof name !== 'string') return null;
      return { ...rest, name };
    },
    slugLabel: 'team',
  });

/**
 * Resolve a review subject ("thing") by slug or ID.
 *
 * @param req
 *  Request object used for redirect handling
 * @param res
 *  Response used for redirects
 * @param id
 *  Slug or UUID for the thing
 * @param loadOptions
 *  Options documented on the Thing model's `getWithData`
 */
const resolveAndLoadThing = (req: Request, res: Response, id: string, loadOptions?: LoadOptions) =>
  resolveAndLoad(req, res, id, loadOptions, {
    basePath: '/',
    slugForeignKey: 'thingID',
    getDocumentModel: async () => Thing as unknown as DocumentModel,
    loadSlug: async (slugName: string, _model: DocumentModel) => {
      const ThingSlugModel = ThingSlug;
      if (!ThingSlugModel || typeof ThingSlugModel.getByName !== 'function') return null;
      // ThingSlug also returns model instances; reshape to a plain object.
      const slugRecord = await ThingSlugModel.getByName(slugName);
      if (!slugRecord || typeof slugRecord !== 'object') {
        return null;
      }
      const { name, ...rest } = slugRecord as Record<string, unknown>;
      if (typeof name !== 'string') return null;
      return { ...rest, name };
    },
    slugLabel: 'thing',
  });

/**
 * Generic resolver that locates a document by slug or UUID and redirects to a
 * canonical slug when necessary.
 *
 * @param req
 *  Request object used for redirect handling
 * @param res
 *  Response used for redirects
 * @param id
 *  Slug or UUID to resolve
 * @param loadOptions
 *  Model-specific options forwarded to `getWithData`
 * @param modelConfig
 *  Configuration describing how to resolve the slug and load the document
 */
const resolveAndLoad = async (
  req: Request,
  res: Response,
  id: string,
  loadOptions: LoadOptions,
  modelConfig: ModelConfig
): Promise<any> => {
  const DocumentModel = modelConfig.getDocumentModel
    ? await modelConfig.getDocumentModel()
    : modelConfig.DocumentModel;

  if (!DocumentModel || typeof DocumentModel.getWithData !== 'function')
    throw new Error('Document model not available for slug resolution');

  const loadDocument = async (documentId: string | null | undefined) => {
    if (!documentId) throw new DocumentNotFound('Slug record does not reference a document');
    return DocumentModel.getWithData(documentId, loadOptions);
  };

  const createRedirectedError = () => {
    const error = new Error();
    error.name = 'RedirectedError';
    return error;
  };

  if (isUUID.v4(id)) {
    const document = await loadDocument(id);

    if (document.canonicalSlugName) {
      redirectToCanonical(req, res, id, modelConfig.basePath, document.canonicalSlugName);
      throw createRedirectedError();
    }

    return document;
  }

  let slug: { name: string; [key: string]: unknown } | null;
  if (typeof modelConfig.loadSlug === 'function') {
    slug = await modelConfig.loadSlug(id, DocumentModel);
  } else {
    const SlugModel = modelConfig.slugModel || modelConfig.SlugModel;
    if (!SlugModel || typeof SlugModel.get !== 'function')
      throw new Error('Slug model not available for slug resolution');
    slug = await SlugModel.get(id);
  }

  if (!slug) {
    const label = modelConfig.slugLabel || 'document';
    throw new DocumentNotFound(`Slug '${id}' not found for ${label}`);
  }

  const document = await loadDocument(slug[modelConfig.slugForeignKey] as string | undefined);

  if (document.canonicalSlugName === slug.name) return document;

  redirectToCanonical(req, res, id, modelConfig.basePath, document.canonicalSlugName);
  throw createRedirectedError();
};

/**
 * Redirect from the current path to the canonical slug while preserving any
 * additional path or query string information.
 */
const redirectToCanonical = (
  req: Request,
  res: Response,
  id: string,
  basePath: string,
  canonicalSlugName?: string
) => {
  const targetSlug = canonicalSlugName ?? id;
  let newPath = basePath + encodeURIComponent(targetSlug);

  const regex = new RegExp(`^${basePath}(.*?)([?/].*)*$`);
  const match = req.originalUrl.match(regex) || [];
  if (match[2]) newPath += match[2];

  res.redirect(newPath);
};

const slugs = {
  resolveAndLoadTeam,
  resolveAndLoadThing,
};

export type SlugHelper = typeof slugs;
export default slugs;
