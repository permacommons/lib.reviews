'use strict';

/**
 * PostgreSQL BlogPost model implementation
 * 
 * This is the PostgreSQL implementation of the BlogPost model using the DAL,
 * maintaining compatibility with the existing RethinkDB BlogPost model interface.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal/lib/ml-string');
const revision = require('../dal/lib/revision');
const isValidLanguage = require('../locales/languages').isValid;
const debug = require('../util/debug');
const { DocumentNotFound } = require('../dal/lib/errors');
const TeamSlug = require('./team-slug');
const { getPostgresUserModel } = require('./user');

let BlogPost = null;

/**
 * Initialize the PostgreSQL BlogPost model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeBlogPostModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping BlogPost model initialization');
    return null;
  }

  try {
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}blog_posts` : 'blog_posts';
    
    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      title: mlString.getSchema({ maxLength: 100 }),
      text: mlString.getSchema(),
      html: mlString.getSchema(),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4).required(true),
      originalLanguage: type.string().max(4).required(true).validator(isValidLanguage),
      userCanEdit: type.virtual().default(false),
      userCanDelete: type.virtual().default(false)
    };

    Object.assign(schema, revision.getSchema());

    BlogPost = dal.createModel(tableName, schema);

    BlogPost._registerFieldMapping('teamID', 'team_id');
    BlogPost._registerFieldMapping('createdOn', 'created_on');
    BlogPost._registerFieldMapping('createdBy', 'created_by');
    BlogPost._registerFieldMapping('originalLanguage', 'original_language');

    BlogPost.createFirstRevision = revision.getFirstRevisionHandler(BlogPost);
    BlogPost.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(BlogPost);

    BlogPost.getWithCreator = getWithCreator;
    BlogPost.getMostRecentBlogPosts = getMostRecentBlogPosts;
    BlogPost.getMostRecentBlogPostsBySlug = getMostRecentBlogPostsBySlug;

    BlogPost.define('newRevision', revision.getNewRevisionHandler(BlogPost));
    BlogPost.define('deleteAllRevisions', revision.getDeleteAllRevisionsHandler(BlogPost));
    BlogPost.define('populateUserInfo', populateUserInfo);

    debug.db('PostgreSQL BlogPost model initialized');
    return BlogPost;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL BlogPost model:', error);
    throw error;
  }
}

/**
 * Get the PostgreSQL BlogPost model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresBlogPostModel(customDAL = null) {
  if (!BlogPost || customDAL) {
    BlogPost = await initializeBlogPostModel(customDAL);
  }
  return BlogPost;
}

async function getWithCreator(id) {
  const post = await BlogPost.getNotStaleOrDeleted(id);
  if (!post) {
    return null;
  }
  await _attachCreator(post);
  return post;
}

async function getMostRecentBlogPosts(teamID, {
  limit = 10,
  offsetDate = undefined
} = {}) {
  if (!teamID) {
    throw new Error('We require a team ID to fetch blog posts.');
  }

  const dal = BlogPost.dal;
  const postsTable = BlogPost.tableName;
  const params = [teamID];
  let paramIndex = 2;

  let query = `
    SELECT *
    FROM ${postsTable}
    WHERE team_id = $1
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
      AND (_old_rev_of IS NULL)
  `;

  if (offsetDate) {
    query += ` AND created_on < $${paramIndex}`;
    params.push(offsetDate);
    paramIndex++;
  }

  query += ` ORDER BY created_on DESC LIMIT $${paramIndex}`;
  params.push(limit + 1);

  const result = await dal.query(query, params);

  const posts = await Promise.all(
    result.rows.map(async row => {
      const post = BlogPost._createInstance(row);
      await _attachCreator(post);
      return post;
    })
  );

  const blogPosts = posts.filter(Boolean);

  const response = { blogPosts };

  if (blogPosts.length === limit + 1) {
    const offsetPost = blogPosts[limit - 1];
    response.offsetDate = offsetPost.createdOn;
    blogPosts.pop();
  }

  return response;
}

async function getMostRecentBlogPostsBySlug(teamSlugName, options) {
  const slug = await TeamSlug.get(teamSlugName);
  if (!slug || !slug.teamID) {
    throw new DocumentNotFound(`Slug '${teamSlugName}' not found for team`);
  }
  return getMostRecentBlogPosts(slug.teamID, options);
}

function populateUserInfo(user) {
  if (!user) {
    return;
  }

  if (user.isSuperUser || user.id === this.createdBy) {
    this.userCanEdit = true;
  }

  if (user.isSuperUser || user.id === this.createdBy || user.isSiteModerator) {
    this.userCanDelete = true;
  }
}

async function _attachCreator(post) {
  if (!post || !post.createdBy) {
    return post;
  }

  try {
    const dal = BlogPost.dal;
    const userTable = dal.tablePrefix ? `${dal.tablePrefix}users` : 'users';
    const query = `
      SELECT *
      FROM ${userTable}
      WHERE id = $1
    `;
    const result = await dal.query(query, [post.createdBy]);
    if (!result.rows.length) {
      return post;
    }

    const User = await getPostgresUserModel(BlogPost.dal);
    const user = User._createInstance(result.rows[0]);
    post.creator = {
      id: user.id,
      displayName: user.displayName,
      urlName: user.urlName
    };
  } catch (error) {
    debug.db('Failed to load blog post creator:', error);
  }

  return post;
}

module.exports = {
  initializeBlogPostModel,
  getPostgresBlogPostModel
};
