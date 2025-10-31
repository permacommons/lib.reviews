// External dependencies
import isUUID from 'is-uuid';

// Internal dependencies
import errors from '../../dal/lib/errors.js';
import Team from '../../models/team.mjs';
import Thing from '../../models/thing.mjs';
import ThingSlug from '../../models/thing-slug.mjs';

const { DocumentNotFound } = errors;

let teamSlugModulePromise;
async function getTeamSlugModel() {
  if (!teamSlugModulePromise) {
    teamSlugModulePromise = import('../../models/team-slug.mjs');
  }
  const module = await teamSlugModulePromise;
  return module.default;
}

const slugs = {

  // Helper function to resolve a team's "slug" or ID and load it with specified
  // options. Returns promise that resolves if team is successfully loaded,
  // and rejects if we can't find a team, or if we redirect.
  //
  // id - the slug or UUID of the team
  // loadOptions - an object documented in models/team.
  resolveAndLoadTeam(req, res, id, loadOptions) {

    return _resolveAndLoad(req, res, id, loadOptions, {
      basePath: '/team/',
      slugForeignKey: 'teamID',
      getDocumentModel: () => Team,
      loadSlug: async (slugName, DocumentModel) => {
        const TeamSlugModel = await getTeamSlugModel();
        if (!TeamSlugModel || typeof TeamSlugModel.getByName !== 'function') {
          return null;
        }
        return await TeamSlugModel.getByName(slugName);
      },
      slugLabel: 'team'
    });

  },

  // As above, for review subjects ('things')
  resolveAndLoadThing(req, res, id, loadOptions) {

    return _resolveAndLoad(req, res, id, loadOptions, {
      basePath: '/',
      slugForeignKey: 'thingID',
      getDocumentModel: () => Thing,
      loadSlug: async (slugName, DocumentModel) => {
        const ThingSlugModel = ThingSlug;
        if (!ThingSlugModel || typeof ThingSlugModel.getByName !== 'function') {
          return null;
        }
        return await ThingSlugModel.getByName(slugName);
      },
      slugLabel: 'thing'
    });
  }

};

// Generic internal function to resolve a document's unique human-readable short
// identifier (slug) or UUID. modelConfig object:
//
//   getDocumentModel: function returning a Promise resolving to the model class
//   slugModel: class name of Model for relevant slugs
//   slugForeignKey: name of the ID key in the slug table that refers back to the
//     document
//   basePath: base URL of any canonical URL we redirect to
async function _resolveAndLoad(req, res, id, loadOptions, modelConfig) {
  const DocumentModel = modelConfig.getDocumentModel
    ? await modelConfig.getDocumentModel()
    : modelConfig.DocumentModel;

  if (!DocumentModel || typeof DocumentModel.getWithData !== 'function') {
    throw new Error('Document model not available for slug resolution');
  }

  const loadDocument = async documentId => {
    if (!documentId) {
      throw new DocumentNotFound('Slug record does not reference a document');
    }
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
      _redirectToCanonical(req, res, id, modelConfig.basePath, document.canonicalSlugName);
      throw createRedirectedError();
    }

    return document;
  }

  let slug;
  if (typeof modelConfig.loadSlug === 'function') {
    slug = await modelConfig.loadSlug(id, DocumentModel);
  } else {
    const SlugModel = modelConfig.slugModel || modelConfig.SlugModel;
    if (!SlugModel || typeof SlugModel.get !== 'function') {
      throw new Error('Slug model not available for slug resolution');
    }
    slug = await SlugModel.get(id);
  }

  if (!slug) {
    const label = modelConfig.slugLabel || 'document';
    throw new DocumentNotFound(`Slug '${id}' not found for ${label}`);
  }

  const document = await loadDocument(slug[modelConfig.slugForeignKey]);

  if (document.canonicalSlugName === slug.name) {
    return document;
  }

  _redirectToCanonical(req, res, id, modelConfig.basePath, document.canonicalSlugName);
  throw createRedirectedError();
}

// Redirect from current page to the canonical URL
function _redirectToCanonical(req, res, id, basePath, canonicalSlugName) {
  let newPath = basePath + encodeURIComponent(canonicalSlugName);

  // Append additional path or query string info
  let regex = new RegExp(`^${basePath}(.*?)([?/].*)*$`); // Match path or query string as [2]
  let match = req.originalUrl.match(regex) || [];
  if (match[2])
    newPath += match[2];

  res.redirect(newPath);
}

export default slugs;
