'use strict';

/**
 * Model for file metadata.
 *
 * @namespace File
 */
const thinky = require('../db');
const r = thinky.r;
const type = thinky.type;
const mlString = require('./helpers/ml-string');
const revision = require('./helpers/revision');

const User = require('./user');
const validLicenses = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'];

/* eslint-disable newline-per-chained-call */ /* for schema readability */

const fileSchema = {
  id: type.string().uuid(4),
  name: type.string().max(512),
  description: mlString.getSchema(),
  uploadedBy: type.string().uuid(4),
  uploadedOn: type.date(),
  mimeType: type.string(),
  license: type.string().enum(validLicenses),
  // Provided by uploader: if not the author, who is?
  creator: mlString.getSchema(),
  // Provided by uploader: where does this file come from?
  source: mlString.getSchema(),
  // Uploaded files with incomplete metadata are stored in a separate directory
  completed: type.boolean().default(false),
  userCanDelete: type.virtual().default(false),
  userIsCreator: type.virtual().default(false)
};

/* eslint-enable newline-per-chained-call */ /* for schema readability */

Object.assign(fileSchema, revision.getSchema());
const File = thinky.createModel("files", fileSchema);

File.belongsTo(User, "uploader", "uploadedBy", "id");
File.ensureIndex("uploadedOn");

// NOTE: STATIC METHODS --------------------------------------------------------

// Standard handlers

File.createFirstRevision = revision.getFirstRevisionHandler(File);
File.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(File);
File.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(File);
File.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(File);

// Custom handlers

File.getStashedUpload = async function(userID, name) {
  const files = await File
    .filter({
      name,
      uploadedBy: userID,
      completed: false
    })
    .filter({ _revDeleted: false }, { default: true })
    .filter({ _oldRevOf: false }, { default: true });
  return files[0];
};

File.getValidLicenses = () => validLicenses.slice();

File.getFileFeed = async function({ offsetDate, limit = 10 } = {}) {
  let query = File;

  if (offsetDate && offsetDate.valueOf)
    query = query.between(r.minval, r.epochTime(offsetDate.valueOf() / 1000), {
      index: 'uploadedOn',
      rightBound: 'open' // Do not return previous record that exactly matches offset
    });

  query = query
    .filter({ _revDeleted: false }, { default: true })
    .filter({ _oldRevOf: false }, { default: true })
    .filter({ completed: true })
    .getJoin({ things: true, uploader: true })
    .orderBy(r.desc('uploadedOn'))
    .limit(limit + 1);

  const feed = {
    items: await query
  };

  // At least one additional document available, set offset for pagination
  if (feed.items.length == limit + 1) {
    feed.offsetDate = feed.items[limit - 1].uploadedOn;
    feed.items.pop();
  }
  return feed;

};

// NOTE: INSTANCE METHODS ------------------------------------------------------

// Standard handlers

File.define("newRevision", revision.getNewRevisionHandler(File));
File.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(File));
File.define("populateUserInfo", populateUserInfo);

/**
 * Populate virtual permission fields in a File object with the rights of a
 * given user.
 *
 * @param {User} user
 *  the user whose permissions to check
 * @memberof File
 * @instance
 */
function populateUserInfo(user) {
  if (!user)
    return; // Permissions will be at their default value (false)

  this.userIsCreator = user.id === this.createdBy;
  this.userCanDelete = this.userIsCreator || user.isSuperUser || user.isSiteModerator || false;
}

module.exports = File;
