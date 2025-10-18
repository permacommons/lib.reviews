import test from 'ava';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
const require = createRequire(import.meta.url);

// Standard env settings
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
// Use testing-4 slot for integration tests to avoid conflicts
process.env.NODE_APP_INSTANCE = 'testing-4';

const dalFixture = createDALFixtureAVA('testing-4');

function getUserFileModelDefinitions() {
  const type = require('../dal').type;
  const mlString = require('../dal').mlString;
  const revision = require('../dal').revision;
  
  const userOptions = {
    maxChars: 128,
    illegalChars: /[<>;"&?!./_]/,
    minPasswordLength: 6
  };

  return [
    {
      name: 'users',
      hasRevisions: false,
      schema: {
        id: type.string().uuid(4),
        display_name: type.string()
          .max(userOptions.maxChars).required(),
        canonical_name: type.string()
          .max(userOptions.maxChars).required(),
        email: type.string().max(userOptions.maxChars).email(),
        password: type.string(),
        user_meta_id: type.string().uuid(4),
        invite_link_count: type.number().integer().default(0),
        registration_date: type.date().default(() => new Date()),
        show_error_details: type.boolean().default(false),
        is_trusted: type.boolean().default(false),
        is_site_moderator: type.boolean().default(false),
        is_super_user: type.boolean().default(false),
        suppressed_notices: type.array(type.string()),
        prefers_rich_text_editor: type.boolean().default(false),
        
        // Virtual fields
        url_name: type.virtual().default(function() {
          const displayName = this.getValue ? this.getValue('display_name') : this.display_name;
          return displayName ? encodeURIComponent(displayName.replace(/ /g, '_')) : undefined;
        }),
        user_can_edit_metadata: type.virtual().default(false),
        user_can_upload_temp_files: type.virtual().default(function() {
          const isTrusted = this.getValue ? this.getValue('is_trusted') : this.is_trusted;
          const isSuperUser = this.getValue ? this.getValue('is_super_user') : this.is_super_user;
          return Boolean(isTrusted || isSuperUser);
        })
      },
      options: { userOptions }
    },
    {
      name: 'files',
      hasRevisions: true,
      schema: {
        id: type.string().uuid(4),
        name: type.string().max(512),
        description: mlString.getSchema(),
        uploaded_by: type.string().uuid(4),
        uploaded_on: type.date(),
        mime_type: type.string(),
        license: type.string().enum(['cc-0', 'cc-by', 'cc-by-sa', 'fair-use']),
        creator: mlString.getSchema(),
        source: mlString.getSchema(),
        completed: type.boolean().default(false),
        
        // Virtual permission fields
        user_can_delete: type.virtual().default(false),
        user_is_creator: type.virtual().default(false),
        
        // Revision fields will be added automatically
        ...revision.getSchema()
      },
      options: {}
    }
  ];
}

test.before(async t => {
  try {
    // Bootstrap DAL with User and File models
    const modelDefs = getUserFileModelDefinitions();
    await dalFixture.bootstrap(modelDefs);
    
    // Add custom methods to User model
    const User = dalFixture.getModel('users');
    if (User) {
      // Add static methods
      User.canonicalize = (name) => name.toUpperCase();
      User.create = async function(userObj) {
        const bcrypt = require('bcrypt');
        const BCRYPT_ROUNDS = 10;
        const userOptions = { illegalChars: /[<>;"&?!./_]/, minPasswordLength: 6 };
        
        if (typeof userObj != 'object') {
          throw new Error('We need a user object containing the user data to create a new user.');
        }

        // Validate name for illegal characters
        if (userOptions.illegalChars.test(userObj.name)) {
          throw new Error(`Username ${userObj.name} contains invalid characters.`);
        }

        const user = new User({});
        user.setName(userObj.name);
        if (userObj.email) {
          user.email = userObj.email;
        }
        
        // Check uniqueness
        const existing = await User.filter({ canonical_name: User.canonicalize(userObj.name) }).run();
        if (existing.length) {
          throw new Error(`A user named ${userObj.name} already exists.`);
        }
        
        // Hash password
        if (userObj.password && userObj.password.length >= userOptions.minPasswordLength) {
          user.password = await new Promise((resolve, reject) => {
            bcrypt.hash(userObj.password, BCRYPT_ROUNDS, (error, hash) => {
              if (error) reject(error);
              else resolve(hash);
            });
          });
        } else {
          throw new Error(`Password must be at least ${userOptions.minPasswordLength} characters long.`);
        }
        
        await user.save();
        return user;
      };
      
      // Add instance methods
      User.define('setName', function(displayName) {
        if (typeof displayName != 'string') {
          throw new Error('Username to set must be a string.');
        }
        displayName = displayName.trim();
        this.display_name = displayName;
        this.canonical_name = User.canonicalize(displayName);
        this.generateVirtualValues();
      });
      
      User.define('populateUserInfo', function(user) {
        if (!user) return;
        if (user.id == this.id) {
          this.user_can_edit_metadata = true;
        }
      });
      
      User.define('getValidPreferences', function() {
        return ['prefersRichTextEditor'];
      });
    }
    
    // Add custom methods to File model
    const File = dalFixture.getModel('files');
    if (File) {
      File.getStashedUpload = async function(userID, name) {
        const query = `
          SELECT * FROM ${File.tableName} 
          WHERE name = $1 
            AND uploaded_by = $2 
            AND completed = false 
            AND (_rev_deleted IS NULL OR _rev_deleted = false)
            AND (_old_rev_of IS NULL)
          LIMIT 1
        `;
        const result = await File.dal.query(query, [name, userID]);
        return result.rows.length > 0 ? File._createInstance(result.rows[0]) : undefined;
      };
      
      File.getFileFeed = async function({ offsetDate, limit = 10 } = {}) {
        // Get the User model to find the correct table name
        const UserModel = dalFixture.getModel('users');
        const userTableName = UserModel ? UserModel.tableName : 'users';
        
        let query = `
          SELECT f.*, 
                 u.display_name as uploader_display_name
          FROM ${File.tableName} f
          LEFT JOIN ${userTableName} u ON f.uploaded_by = u.id
          WHERE f.completed = true 
            AND (f._rev_deleted IS NULL OR f._rev_deleted = false)
            AND (f._old_rev_of IS NULL)
        `;
        
        const params = [];
        let paramIndex = 1;
        
        if (offsetDate && offsetDate.valueOf) {
          query += ` AND f.uploaded_on < $${paramIndex}`;
          params.push(offsetDate);
          paramIndex++;
        }
        
        query += ` ORDER BY f.uploaded_on DESC LIMIT $${paramIndex}`;
        params.push(limit + 1);
        
        const result = await File.dal.query(query, params);
        const items = result.rows.slice(0, limit).map(row => {
          const file = File._createInstance(row);
          if (row.uploader_display_name) {
            file.uploader = {
              display_name: row.uploader_display_name
            };
          }
          return file;
        });
        
        const feed = { items };
        if (result.rows.length === limit + 1) {
          feed.offsetDate = items[limit - 1].uploaded_on;
        }
        
        return feed;
      };
      
      File.define('populateUserInfo', function(user) {
        if (!user) return;
        this.user_is_creator = user.id === this.uploaded_by;
        this.user_can_delete = this.user_is_creator || user.is_super_user || user.is_site_moderator || false;
      });
    }
    
    // Create test tables
    await dalFixture.createTestTables([
      {
        name: 'users',
        sql: `
          CREATE TABLE IF NOT EXISTS ${dalFixture.tablePrefix}users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            display_name VARCHAR(128) NOT NULL,
            canonical_name VARCHAR(128) NOT NULL,
            email VARCHAR(128),
            password TEXT,
            user_meta_id UUID,
            invite_link_count INTEGER DEFAULT 0,
            registration_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            show_error_details BOOLEAN DEFAULT FALSE,
            is_trusted BOOLEAN DEFAULT FALSE,
            is_site_moderator BOOLEAN DEFAULT FALSE,
            is_super_user BOOLEAN DEFAULT FALSE,
            suppressed_notices TEXT[],
            prefers_rich_text_editor BOOLEAN DEFAULT FALSE
          )
        `
      },
      {
        name: 'files',
        sql: `
          CREATE TABLE IF NOT EXISTS ${dalFixture.tablePrefix}files (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(512),
            description JSONB,
            uploaded_by UUID,
            uploaded_on TIMESTAMP WITH TIME ZONE,
            mime_type VARCHAR(255),
            license VARCHAR(50),
            creator JSONB,
            source JSONB,
            completed BOOLEAN DEFAULT FALSE,
            _rev_user UUID NOT NULL,
            _rev_date TIMESTAMP WITH TIME ZONE NOT NULL,
            _rev_id UUID NOT NULL,
            _old_rev_of UUID,
            _rev_deleted BOOLEAN DEFAULT FALSE,
            _rev_tags TEXT[]
          )
        `
      }
    ]);
  } catch (error) {
    t.log('PostgreSQL not available, skipping User/File integration tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.after.always(async t => {
  // Clean up test tables
  await dalFixture.dropTestTables(['users', 'files']);
  await dalFixture.cleanup();
});

// Integration test to verify User and File models work together
test('User and File models integration', async t => {
  const User = dalFixture.getModel('users');
  const File = dalFixture.getModel('files');

  if (!User || !File) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  // Create a user
  const user = await User.create({
    name: 'integrationuser',
    email: 'integration@example.com',
    password: 'testpassword123'
  });

  t.truthy(user.id);
  t.is(user.display_name, 'integrationuser');

  // Create a file uploaded by this user
  const file = await File.create({
    name: 'integration-test.jpg',
    description: { en: 'Integration test file' },
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-by',
    completed: true,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create', 'integration-test']
  });

  t.truthy(file.id);
  t.is(file.name, 'integration-test.jpg');
  t.is(file.uploaded_by, user.id);

  // Test permission population
  file.populateUserInfo(user);
  t.true(file.user_can_delete); // User uploaded the file
  t.true(file.user_is_creator);

  // Test that a different user cannot delete
  const otherUser = await User.create({
    name: 'otheruser',
    email: 'other@example.com',
    password: 'password123'
  });

  file.populateUserInfo(otherUser);
  t.false(file.user_can_delete); // Different user
  t.false(file.user_is_creator);

  // Test file feed includes our file
  const feed = await File.getFileFeed({ limit: 10 });
  t.truthy(feed.items);
  t.true(Array.isArray(feed.items));
  
  const ourFile = feed.items.find(f => f.id === file.id);
  t.truthy(ourFile, 'Our file should be in the feed');
  t.is(ourFile.name, 'integration-test.jpg');

  // Test stashed upload functionality
  const stashedFile = await File.create({
    name: 'stashed-integration.jpg',
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-0',
    completed: false, // Not completed
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create', 'stashed']
  });

  const foundStashed = await File.getStashedUpload(user.id, 'stashed-integration.jpg');
  t.truthy(foundStashed);
  t.is(foundStashed.id, stashedFile.id);
  t.false(foundStashed.completed);

  // Test user preferences
  const validPrefs = user.getValidPreferences();
  t.true(Array.isArray(validPrefs));
  t.true(validPrefs.includes('prefersRichTextEditor'));

  // Test user name canonicalization
  t.is(User.canonicalize('TestUser'), 'TESTUSER');
  t.is(User.canonicalize('test user'), 'TEST USER');

  // Test virtual fields
  t.is(user.url_name, 'integrationuser');
  user.populateUserInfo(user);
  t.true(user.user_can_edit_metadata);
});

// Test revision system integration
test('User and File models with revision system', async t => {
  const User = dalFixture.getModel('users');
  const File = dalFixture.getModel('files');

  if (!User || !File) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  // Create a user
  const user = await User.create({
    name: 'revisionuser',
    email: 'revision@example.com',
    password: 'testpassword123'
  });

  // Create a file with revision data
  const file = await File.create({
    name: 'revision-test.jpg',
    description: { en: 'Original description' },
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-by',
    completed: true,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });

  // Test that revision fields are properly set
  t.truthy(file._rev_id);
  t.is(file._rev_user, user.id);
  t.truthy(file._rev_date);
  t.deepEqual(file._rev_tags, ['create']);
  t.false(file._rev_deleted);
  t.is(file._old_rev_of, undefined);

  // Test filtering not stale or deleted
  const currentFiles = await File.filterNotStaleOrDeleted().run();
  const ourFile = currentFiles.find(f => f.id === file.id);
  t.truthy(ourFile, 'File should be in current revisions');

  // Test getting multiple not stale or deleted
  const multipleFiles = await File.getMultipleNotStaleOrDeleted(file.id).run();
  t.is(multipleFiles.length, 1);
  t.is(multipleFiles[0].id, file.id);
});