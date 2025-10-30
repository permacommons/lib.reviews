'use strict';

/**
 * Example usage of the PostgreSQL DAL
 * 
 * This file demonstrates how to use the new DAL with the same
 * interface as the existing Thinky ORM.
 */

const DAL = require('./index');
const type = DAL.type;

// Example configuration
const config = {
  host: 'localhost',
  port: 5432,
  database: 'libreviews',
  user: 'postgres',
  password: 'password',
  max: 20 // connection pool size
};

async function example() {
  // Initialize DAL
  const dal = DAL(config);
  await dal.connect();
  
  // Run migrations
  await dal.migrate();
  
  // Create a model (similar to Thinky syntax)
  const User = dal.createModel('users', {
    id: type.string().uuid(4),
    displayName: type.string().max(128).required(),
    canonicalName: type.string().max(128).required(),
    email: type.string().max(128).email(),
    password: type.string(),
    registrationDate: type.date().default(() => new Date()),
    isTrusted: type.boolean().default(false),
    
    // Virtual field example
    urlName: type.virtual().default(function() {
      return this.displayName ? encodeURIComponent(this.displayName.replace(/ /g, '_')) : undefined;
    })
  });
  
  // Example operations
  try {
    // Create a user
    const user = await User.create({
      displayName: 'John Doe',
      canonicalName: 'JOHN DOE',
      email: 'john@example.com',
      password: 'hashedpassword'
    });
    
    console.log('Created user:', user.id);
    
    // Find user by ID
    const foundUser = await User.get(user.id);
    console.log('Found user:', foundUser.displayName);
    
    // Filter users
    const users = await User.filter({ isTrusted: false }).run();
    console.log('Found', users.length, 'untrusted users');
    
    // Update user
    foundUser.isTrusted = true;
    await foundUser.save();
    console.log('Updated user trust status');
    
    // === Multilingual String Examples ===
    console.log('\n=== Multilingual String Examples ===');
    
    // Create schemas for multilingual strings
    const titleSchema = DAL.mlString.getSchema({ maxLength: 200 });
    const aliasesSchema = DAL.mlString.getSchema({ array: true, maxLength: 100 });
    
    // Example multilingual data
    const bookTitle = {
      en: 'The Great Gatsby',
      de: 'Der große Gatsby',
      fr: 'Gatsby le Magnifique'
    };
    
    const bookAliases = {
      en: ['The Great Gatsby', 'Gatsby'],
      de: ['Der große Gatsby', 'Gatsby']
    };
    
    // Validate multilingual strings
    titleSchema.validate(bookTitle, 'title');
    console.log('✓ Title validation passed');
    
    aliasesSchema.validate(bookAliases, 'aliases');
    console.log('✓ Aliases validation passed');
    
    // Language resolution examples
    console.log('\nLanguage resolution:');
    console.log('English:', DAL.mlString.resolve('en', bookTitle));
    console.log('German:', DAL.mlString.resolve('de', bookTitle));
    console.log('Spanish (fallback):', DAL.mlString.resolve('es', bookTitle));
    
    // Query building examples
    console.log('\nQuery building:');
    console.log('Simple query:', DAL.mlString.buildQuery('title', 'en', 'The Great Gatsby'));
    console.log('Search query:', DAL.mlString.buildQuery('title', 'en', '%Gatsby%', 'ILIKE'));
    console.log('Multi-language search:', DAL.mlString.buildMultiLanguageQuery('title', '%Gatsby%'));
    
    // HTML stripping example
    const htmlContent = {
      en: '<p>This is <strong>bold</strong> text</p>',
      de: '<p>Das ist <strong>fetter</strong> Text</p>'
    };
    console.log('\nHTML stripping:');
    console.log('Original:', htmlContent);
    console.log('Stripped:', DAL.mlString.stripHTML(htmlContent));
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await dal.disconnect();
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  example().catch(console.error);
}

module.exports = { example };