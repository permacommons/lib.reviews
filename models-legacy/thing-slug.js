'use strict';

/**
 * Model for short human-readable identifiers used in URLs pointing to review
 * subjects ({@link Thing} objects). RethinkDB only enforces uniqueness for
 * primary keys, so we keep these in a separate table.
 *
 * This model is not versioned.
 *
 * @namespace ThingSlug
 */
const thinky = require('../db');
const r = thinky.r;
const type = thinky.type;

// You can use these slugs, but they'll be automatically be qualified with a number
const reservedSlugs = ['register', 'actions', 'signin', 'login', 'teams', 'user', 'new', 'signout', 'logout', 'api', 'faq', 'static', 'terms'];

// Model for unique, human-readable identifiers ('slugs') for review subjects
// ('things')

let thingSlugSchema = {
  name: type.string().max(125),

  baseName: type.string().max(100),
  qualifierPart: type.string().max(25),

  thingID: type.string().uuid(4),
  createdOn: type.date(),
  createdBy: type.string().uuid(4)
};

let ThingSlug = thinky.createModel("thing_slugs", thingSlugSchema, {
  pk: 'name'
});

ThingSlug.ensureIndex("createdOn");


// NOTE: INSTANCE METHODS ------------------------------------------------------

ThingSlug.define("qualifiedSave", qualifiedSave);

/**
 * Save a slug update, adding a numeric qualifier if necessary because we
 * already have a slug pointing to a different thing.
 *
 * @returns {ThingSlug}
 *  the slug that should be associated with the {@link Thing} object.
 * @memberof ThingSlug
 * @instance
 */
async function qualifiedSave() {
  let slug = this;
  slug.baseName = slug.name; // Store base name for later reference
  if (reservedSlugs.indexOf(slug.name.toLowerCase()) !== -1)
    return await _resolveConflicts(); // saves new slug if needed

  try {
    return await slug.save();
  } catch (error) {
    if (error.name == 'DuplicatePrimaryKeyError')
      return await _resolveConflicts(); // saves new slug if needed
    else
      throw error;
  }

  /**
   * Resolves naming conflicts by creating a new slug with a numeric qualifier
   * if needed.
   *
   * @memberof ThingSlug
   * @returns {ThingSlug}
   *  the best available slug to use
   * @inner
   * @protected
   */
  async function _resolveConflicts() {
    // Check first if we've used this base name before for the same target
    let slugs = await ThingSlug
      .filter({
        baseName: slug.name,
        thingID: slug.thingID
      })
      .orderBy(r.desc('createdOn'))
      .limit(1);

    if (slugs.length)
      return slugs[0]; // Got a match, no need to save -- just re-use :)

    // Widen search for most recent use of this base name
    slugs = await ThingSlug
      .filter({
        baseName: slug.name
      })
      .orderBy(r.desc('createdOn'))
      .limit(1);

    let latestQualifierStr;
    if (slugs.length && !isNaN(+slugs[0].qualifierPart))
      latestQualifierStr = String(+slugs[0].qualifierPart + 1);
    else
      latestQualifierStr = '2';
    slug.name = `${slug.name}-${latestQualifierStr}`;
    slug.qualifierPart = latestQualifierStr;
    return await slug.save();
  }
}


module.exports = ThingSlug;
