'use strict';

/**
 * Model for versioned metadata for {@link User} objects (currently just the
 * bio).
 *
 * @namespace UserMeta
 */

const thinky = require('../db');
const type = thinky.type;
const mlString = require('./helpers/ml-string');
const revision = require('./helpers/revision');
const isValidLanguage = require('../locales/languages').isValid;

/* eslint-disable newline-per-chained-call */ /* for schema readability */

let userMetaSchema = {
  id: type.string(),
  bio: {
    text: mlString.getSchema({
      maxLength: 1000
    }),
    html: mlString.getSchema({
      maxLength: 1000
    })
  },
  // We track this to enable collaborative bio translations
  originalLanguage: type.string().max(4).required().validator(isValidLanguage)
};

/* eslint-enable newline-per-chained-call */ /* for schema readability */

// Add versioning related fields
Object.assign(userMetaSchema, revision.getSchema());
let UserMeta = thinky.createModel("user_meta", userMetaSchema);

// NOTE: INSTANCE METHODS ------------------------------------------------------

UserMeta.define("newRevision", revision.getNewRevisionHandler(UserMeta));
UserMeta.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(UserMeta));

module.exports = UserMeta;
