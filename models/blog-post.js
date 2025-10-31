import dal from '../dal/index.js';
import mlString from '../dal/lib/ml-string.js';
import languages from '../locales/languages.js';
import debug from '../util/debug.js';
import dalErrors from '../dal/lib/errors.js';
import User from './user.js';
import modelInitializer from '../dal/lib/model-initializer.js';
import modelHandle from '../dal/lib/model-handle.js';

let postgresModulePromise;
async function loadDbPostgres() {
  if (!postgresModulePromise) {
    postgresModulePromise = import('../db-postgres.js');
  }
  return postgresModulePromise;
}

async function getPostgresDAL() {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { types } = dal;
const { isValid: isValidLanguage } = languages;
const { DocumentNotFound } = dalErrors;
const { initializeModel } = modelInitializer;
const { createAutoModelHandle } = modelHandle;
let teamSlugHandlePromise;
async function loadTeamSlugHandle() {
  if (!teamSlugHandlePromise) {
    teamSlugHandlePromise = import('./team-slug.js');
  }
  const module = await teamSlugHandlePromise;
  return module.default;
}

let BlogPost = null;

/**
 * Initialize the PostgreSQL BlogPost model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeBlogPostModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping BlogPost model initialization');
    return null;
  }

  try {
    const schema = {
      id: types.string().uuid(4),
      teamID: types.string().uuid(4).required(true),
      title: mlString.getSchema({ maxLength: 100 }),
      text: mlString.getSchema(),
      html: mlString.getSchema(),
      createdOn: types.date().default(() => new Date()),
      createdBy: types.string().uuid(4).required(true),
      originalLanguage: types.string().max(4).required(true).validator(isValidLanguage),
      userCanEdit: types.virtual().default(false),
      userCanDelete: types.virtual().default(false)
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'blog_posts',
      schema,
      camelToSnake: {
        teamID: 'team_id',
        createdOn: 'created_on',
        createdBy: 'created_by',
        originalLanguage: 'original_language'
      },
      withRevision: {
        static: ['createFirstRevision', 'getNotStaleOrDeleted'],
        instance: ['deleteAllRevisions']
      },
      staticMethods: {
        getWithCreator,
        getMostRecentBlogPosts,
        getMostRecentBlogPostsBySlug
      },
      instanceMethods: {
        populateUserInfo
      }
    });
    BlogPost = model;

    if (!isNew) {
      return BlogPost;
    }

    debug.db('PostgreSQL BlogPost model initialized');
    return BlogPost;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL BlogPost model:', error);
    throw error;
  }
}

/**
 * Get the PostgreSQL BlogPost model (initialize if needed)
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
*/
async function getPostgresBlogPostModel(dal = null) {
  if (!BlogPost || dal) {
    BlogPost = await initializeBlogPostModel(dal);
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
  const TeamSlug = await loadTeamSlugHandle();
  const slug = await TeamSlug.getByName(teamSlugName);
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
    const userTable = dal.schemaNamespace ? `${dal.schemaNamespace}users` : 'users';
    const query = `
      SELECT *
      FROM ${userTable}
      WHERE id = $1
    `;
    const result = await dal.query(query, [post.createdBy]);
    if (!result.rows.length) {
      return post;
    }

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

const BlogPostHandle = createAutoModelHandle('blog_posts', initializeBlogPostModel);

export default BlogPostHandle;
export { initializeBlogPostModel, initializeBlogPostModel as initializeModel, getPostgresBlogPostModel };
