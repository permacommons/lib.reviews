'use strict';
const thinky = require('../db');
const type = thinky.type;

/**
 * Model for storing short human-readable identifier (slugs) for a given team
 * RethinkDB, being distributed, wants all unique indexes to be primary keys,
 * so we have a separate table for these.
 *
 * @namespace TeamSlug
 */
let teamSlugSchema = {
  name: type.string().max(100),
  teamID: type.string().uuid(4),
  createdOn: type.date(),
  createdBy: type.string().uuid(4)
};

let TeamSlug = thinky.createModel("team_slugs", teamSlugSchema, {
  pk: "name"
});

// Team slugs must be unique (i.e. we don't do the bla-2, bla-3 modification
// we do for review subjects), so a qualified save is just a regular save.
TeamSlug.define("qualifiedSave", function() {
  return this.save();
});

module.exports = TeamSlug;
