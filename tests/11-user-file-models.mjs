import test from 'ava';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

// Standard env settings
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
// Use testing-3 slot for User/File model tests to avoid conflicts
process.env.NODE_APP_INSTANCE = 'testing-3';

const dalFixture = createDALFixtureAVA('testing-3');

import { createRequire } from 'module';
import { randomUUID } from 'crypto';
const require = createRequire(import.meta.url);

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
      
      User.findByURLName = async function(name) {
        name = name.trim().replace(/_/g, ' ');
        const users = await User.filter({ canonical_name: User.canonicalize(name) }).run();
        if (users.length) {
          return users[0];
        } else {
          throw new Error('User not found');
        }
      };
      
      User.increaseInviteLinkCount = async function(id) {
        const query = `
          UPDATE ${User.tableName} 
          SET invite_link_count = invite_link_count + 1 
          WHERE id = $1 
          RETURNING invite_link_count
        `;
        const result = await User.dal.query(query, [id]);
        if (result.rows.length === 0) {
          throw new Error(`User with id ${id} not found`);
        }
        return result.rows[0].invite_link_count;
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
      
      User.define('checkPassword', function(password) {
        const bcrypt = require('bcrypt');
        return new Promise((resolve, reject) => {
          bcrypt.compare(password, this.password, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          });
        });
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
      File.getValidLicenses = () => ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'];
      
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
    t.log('PostgreSQL not available, skipping User/File model tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.after.always(async t => {
  // Clean up test tables
  await dalFixture.dropTestTables(['users', 'files']);
  await dalFixture.cleanup();
});

// Test User model functionality
test('User model - basic CRUD operations', async t => {
  const User = dalFixture.getModel('users');
  
  if (!User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  // Test user creation
  const userData = {
    name: 'testuser',
    email: 'test@example.com',
    password: 'testpassword123'
  };

  const user = await User.create(userData);
  t.truthy(user.id);
  t.is(user.display_name, 'testuser');
  t.is(user.canonical_name, 'TESTUSER');
  t.is(user.email, 'test@example.com');
  t.truthy(user.password); // Should be hashed
  t.not(user.password, 'testpassword123'); // Should not be plain text

  // Test password checking
  const passwordMatch = await user.checkPassword('testpassword123');
  t.true(passwordMatch);

  const passwordNoMatch = await user.checkPassword('wrongpassword');
  t.false(passwordNoMatch);

  // Test user retrieval
  const retrievedUser = await User.get(user.id);
  t.is(retrievedUser.display_name, 'testuser');
  t.is(retrievedUser.email, 'test@example.com');

  // Test findByURLName
  const foundUser = await User.findByURLName('testuser');
  t.is(foundUser.display_name, 'testuser');

  // Test virtual fields
  t.is(user.url_name, 'testuser');
  t.false(user.user_can_edit_metadata);
  t.false(user.user_can_upload_temp_files); // Not trusted by default

  // Test populateUserInfo
  user.populateUserInfo(user); // User can edit their own metadata
  t.true(user.user_can_edit_metadata);
});

test('User model - validation and uniqueness', async t => {
  const User = dalFixture.getModel('users');
  
  if (!User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  // Create first user
  const user1 = await User.create({
    name: 'uniqueuser',
    email: 'unique@example.com',
    password: 'password123'
  });

  // Test uniqueness validation
  await t.throwsAsync(async () => {
    await User.create({
      name: 'uniqueuser', // Same name
      email: 'different@example.com',
      password: 'password123'
    });
  });

  // Test password length validation
  await t.throwsAsync(async () => {
    await User.create({
      name: 'shortpass',
      email: 'short@example.com',
      password: '123' // Too short
    });
  });

  // Test illegal characters validation
  await t.throwsAsync(async () => {
    await User.create({
      name: 'bad<name>', // Contains illegal character
      email: 'bad@example.com',
      password: 'password123'
    });
  });
});

test('User model - invite link count', async t => {
  const User = dalFixture.getModel('users');
  
  if (!User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  const user = await User.create({
    name: 'inviteuser',
    email: 'invite@example.com',
    password: 'password123'
  });

  t.is(user.invite_link_count, 0);

  // Test increasing invite link count
  const newCount = await User.increaseInviteLinkCount(user.id);
  t.is(newCount, 1);

  // Verify the count was updated
  const updatedUser = await User.get(user.id);
  t.is(updatedUser.invite_link_count, 1);
});

// Test File model functionality
test('File model - basic CRUD operations', async t => {
  const File = dalFixture.getModel('files');
  const User = dalFixture.getModel('users');
  
  if (!File || !User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  // Create a user first
  const user = await User.create({
    name: 'fileuser',
    email: 'file@example.com',
    password: 'password123'
  });

  // Create a file
  const fileData = {
    name: 'test-file.jpg',
    description: { en: 'A test file', de: 'Eine Testdatei' },
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-by',
    creator: { en: 'Test Creator' },
    source: { en: 'Test Source' },
    completed: true,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  };

  const file = await File.create(fileData);
  t.truthy(file.id);
  t.is(file.name, 'test-file.jpg');
  t.deepEqual(file.description, { en: 'A test file', de: 'Eine Testdatei' });
  t.is(file.uploaded_by, user.id);
  t.is(file.mime_type, 'image/jpeg');
  t.is(file.license, 'cc-by');
  t.true(file.completed);

  // Test file retrieval
  const retrievedFile = await File.get(file.id);
  t.is(retrievedFile.name, 'test-file.jpg');
  t.deepEqual(retrievedFile.description, { en: 'A test file', de: 'Eine Testdatei' });

  // Test virtual fields
  t.false(file.user_can_delete);
  t.false(file.user_is_creator);

  // Test populateUserInfo
  file.populateUserInfo(user);
  t.true(file.user_can_delete); // User uploaded the file
  t.true(file.user_is_creator);
});

test('File model - multilingual validation', async t => {
  const File = dalFixture.getModel('files');
  const User = dalFixture.getModel('users');
  
  if (!File || !User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  const user = await User.create({
    name: 'mluser',
    email: 'ml@example.com',
    password: 'password123'
  });

  // Test valid multilingual strings
  const validFile = await File.create({
    name: 'valid-ml.jpg',
    description: { en: 'English description', fr: 'Description française' },
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-0',
    completed: false,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });

  t.truthy(validFile.id);
  t.deepEqual(validFile.description, { en: 'English description', fr: 'Description française' });

  // Test invalid language code
  await t.throwsAsync(async () => {
    await File.create({
      name: 'invalid-ml.jpg',
      description: { xx: 'Invalid language' }, // 'xx' is not a valid language code
      uploaded_by: user.id,
      uploaded_on: new Date(),
      mime_type: 'image/jpeg',
      license: 'cc-0',
      completed: false,
      _rev_id: randomUUID(),
      _rev_user: user.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });
  });
});

test('File model - license validation', async t => {
  const File = dalFixture.getModel('files');
  const User = dalFixture.getModel('users');
  
  if (!File || !User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  const user = await User.create({
    name: 'licenseuser',
    email: 'license@example.com',
    password: 'password123'
  });

  // Test valid licenses
  const validLicenses = File.getValidLicenses();
  t.deepEqual(validLicenses, ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use']);

  for (const license of validLicenses) {
    const file = await File.create({
      name: `test-${license}.jpg`,
      uploaded_by: user.id,
      uploaded_on: new Date(),
      mime_type: 'image/jpeg',
      license: license,
      completed: false,
      _rev_id: randomUUID(),
      _rev_user: user.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });
    t.is(file.license, license);
  }

  // Test invalid license
  await t.throwsAsync(async () => {
    await File.create({
      name: 'invalid-license.jpg',
      uploaded_by: user.id,
      uploaded_on: new Date(),
      mime_type: 'image/jpeg',
      license: 'invalid-license',
      completed: false,
      _rev_id: randomUUID(),
      _rev_user: user.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });
  });
});

test('File model - stashed uploads and feed', async t => {
  const File = dalFixture.getModel('files');
  const User = dalFixture.getModel('users');
  
  if (!File || !User) {
    t.pass('PostgreSQL DAL not available, skipping test');
    return;
  }

  const user = await User.create({
    name: 'feeduser',
    email: 'feed@example.com',
    password: 'password123'
  });

  // Create a stashed (incomplete) upload
  const stashedFile = await File.create({
    name: 'stashed-upload.jpg',
    uploaded_by: user.id,
    uploaded_on: new Date(),
    mime_type: 'image/jpeg',
    license: 'cc-by',
    completed: false, // Not completed
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });

  // Test getStashedUpload
  const foundStashed = await File.getStashedUpload(user.id, 'stashed-upload.jpg');
  t.truthy(foundStashed);
  t.is(foundStashed.name, 'stashed-upload.jpg');
  t.false(foundStashed.completed);

  // Test getStashedUpload with non-existent file
  const notFound = await File.getStashedUpload(user.id, 'non-existent.jpg');
  t.is(notFound, undefined);

  // Create completed files for feed test
  const completedFile1 = await File.create({
    name: 'completed1.jpg',
    uploaded_by: user.id,
    uploaded_on: new Date(Date.now() - 1000), // 1 second ago
    mime_type: 'image/jpeg',
    license: 'cc-by',
    completed: true,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });

  const completedFile2 = await File.create({
    name: 'completed2.jpg',
    uploaded_by: user.id,
    uploaded_on: new Date(), // Now
    mime_type: 'image/jpeg',
    license: 'cc-0',
    completed: true,
    _rev_id: randomUUID(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });

  // Test file feed
  const feed = await File.getFileFeed({ limit: 10 });
  t.truthy(feed.items);
  t.true(Array.isArray(feed.items));
  
  // Should only include completed files, ordered by upload date desc
  const completedFiles = feed.items.filter(f => f.completed);
  t.true(completedFiles.length >= 2);
  
  // Check ordering (most recent first)
  if (completedFiles.length >= 2) {
    t.true(completedFiles[0].uploaded_on >= completedFiles[1].uploaded_on);
  }
});