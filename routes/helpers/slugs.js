'use strict';
// External dependencies
const isUUID = require('is-uuid');

// Internal dependencies
const { DocumentNotFound } = require('../../dal/lib/errors');
const Team = require('../../models-postgres/team');
const TeamSlug = require('../../models-postgres/team-slug');
const Thing = require('../../models-postgres/thing');
const ThingSlug = require('../../models-postgres/thing-slug');

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
        const dal = DocumentModel && DocumentModel.dal;
        if (!dal) {
          return null;
        }
        const TeamSlugModel = TeamSlug;
        if (!TeamSlugModel) {
          return null;
        }
        const tableName = dal.tablePrefix ? `${dal.tablePrefix}team_slugs` : 'team_slugs';
        const result = await dal.query(`SELECT * FROM ${tableName} WHERE name = $1`, [slugName]);
        if (!result.rows.length) {
          return null;
        }

        const row = result.rows[0];
        if (TeamSlugModel && typeof TeamSlugModel._createInstance === 'function') {
          return TeamSlugModel._createInstance(row);
        }
        return new TeamSlugModel(row);
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
        const dal = DocumentModel && DocumentModel.dal;
        if (!dal) {
          return null;
        }
        const ThingSlugModel = ThingSlug;
        if (!ThingSlugModel) {
          return null;
        }
        const tableName = dal.tablePrefix ? `${dal.tablePrefix}thing_slugs` : 'thing_slugs';
        const result = await dal.query(`SELECT * FROM ${tableName} WHERE name = $1`, [slugName]);
        if (!result.rows.length) {
          return null;
        }

        const row = result.rows[0];
        if (ThingSlugModel && typeof ThingSlugModel._createInstance === 'function') {
          return ThingSlugModel._createInstance(row);
        }
        return new ThingSlugModel(row);
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

module.exports = slugs;
