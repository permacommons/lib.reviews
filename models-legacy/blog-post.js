'use strict';

/**
 * Model for blog posts. Blog posts can currently only be authored by teams: one
 * team can have many blog posts.
 *
 * @namespace BlogPost
 */
const thinky = require('../db');
const r = thinky.r;
const type = thinky.type;
const mlString = require('./helpers/ml-string');
const revision = require('./helpers/revision');
const isValidLanguage = require('../locales/languages').isValid;
const User = require('./user');
const TeamSlug = require('./team-slug');

/* eslint-disable newline-per-chained-call */
/* for schema readability */

let blogPostSchema = {

  id: type.string(),
  teamID: type.string().uuid(4),
  title: mlString.getSchema({
    maxLength: 100
  }),
  post: {
    text: mlString.getSchema(),
    html: mlString.getSchema()
  },
  // Track original authorship
  createdOn: type.date(),
  createdBy: type.string(),
  originalLanguage: type.string().max(4).required().validator(isValidLanguage),
  userCanEdit: type.virtual().default(false),
  userCanDelete: type.virtual().default(false)
};

/* eslint-enable newline-per-chained-call */

// Add versioning related fields
Object.assign(blogPostSchema, revision.getSchema());
let BlogPost = thinky.createModel("blog_posts", blogPostSchema);

BlogPost.ensureIndex("createdOn");
BlogPost.belongsTo(User, "creator", "createdBy", "id");

// NOTE: STATIC METHODS --------------------------------------------------------

// Standard handlers

BlogPost.createFirstRevision = revision.getFirstRevisionHandler(BlogPost);
BlogPost.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(BlogPost);

// Custom methods

/**
 * Get a blog post and the user object representing its original author
 *
 * @param {String} id
 *  blog post ID
 * @returns {BlogPost}
 *  post with populated `.creator` property
 * @async
 */
BlogPost.getWithCreator = async function(id) {
  const post = await BlogPost
    .get(id)
    .getJoin({
      creator: {
        _apply: seq => seq.without('password')
      }
    });

  if (post._revDeleted)
    throw revision.deletedError;

  if (post._oldRevOf)
    throw revision.staleError;

  return post;
};

/**
 * Get the most recent blog posts for a given team
 *
 * @param {String} teamID
 *  team ID to look up
 * @param {Object} [options]
 *  query criteria
 * @param {Number} options.limit=10
 *  number of posts to retrieve
 * @param {Date} options.offsetDate
 *  only get posts older than this date
 * @returns {BlogPosts[]}
 * @async
 */
BlogPost.getMostRecentBlogPosts = async function(teamID, {
  limit = 10,
  offsetDate = undefined
} = {}) {

  if (!teamID)
    throw new Error('We require a team ID to fetch blog posts.');

  let query = BlogPost;

  if (offsetDate && offsetDate.valueOf)
    query = query.between(r.minval, r.epochTime(offsetDate.valueOf() / 1000), {
      index: 'createdOn',
      rightBound: 'open' // Do not return previous record that exactly matches offset
    });

  query = query
    .orderBy({ index: r.desc('createdOn') })
    .filter({ teamID })
    .filter({ _revDeleted: false }, { default: true })
    .filter({ _oldRevOf: false }, { default: true })
    .limit(limit + 1) // One over limit to check if we need potentially another set
    .getJoin({
      creator: {
        _apply: seq => seq.without('password')
      }
    });

  const posts = await query;
  const result = {};

  // At least one additional document available, set offset for pagination
  if (posts.length == limit + 1) {
    result.offsetDate = posts[limit - 1].createdOn;
    posts.pop();
  }

  result.blogPosts = posts;
  return result;
};

/**
 * Get blog posts for a given team slug.
 *
 * @param {String} teamSlugName
 *  slug (short human-readable identifier) for a team
 * @param {Object} [options]
 *  options supported by {@link BlogPost.getMostRecentBlogPosts}
 * @returns {BlogPost[]}
 * @async
 */
BlogPost.getMostRecentBlogPostsBySlug = async function(teamSlugName, options) {
  const slug = await TeamSlug.get(teamSlugName);
  const posts = BlogPost.getMostRecentBlogPosts(slug.teamID, options);
  return posts;
};

// NOTE: INSTANCE METHODS ------------------------------------------------------

// Standard handlers

BlogPost.define("newRevision", revision.getNewRevisionHandler(BlogPost));
BlogPost.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(BlogPost));

// Custom methods

BlogPost.define("populateUserInfo", populateUserInfo);

/**
 * Populate virtual permission fields for this post based on a given user
 *
 * @param {User} user
 *  the user whose permissions to check
 * @instance
 * @memberof BlogPost
 */
function populateUserInfo(user) {

  if (!user) // Keep at permissions at default (false)
    return;

  if (user.isSuperUser || user.id === this.createdBy)
    this.userCanEdit = true;

  if (user.isSuperUser || user.id === this.createdBy || user.isSiteModerator)
    this.userCanDelete = true;
}

module.exports = BlogPost;
