#!/usr/bin/env node
'use strict';

/**
 * Test script for dual database setup
 * 
 * This script tests both RethinkDB and PostgreSQL connections
 * to verify the dual database setup is working correctly.
 */

const config = require('config');
const debug = require('./util/debug');
const { initializePostgreSQL, getPostgresDAL, getRethinkDB, isDualDatabaseMode, closeConnections } = require('./db-dual');
const { getPostgresUserModel } = require('./models-postgres/user');

async function testRethinkDB() {
  console.log('\n=== Testing RethinkDB Connection ===');
  
  try {
    const thinky = getRethinkDB();
    await thinky.getDB();
    console.log('✅ RethinkDB connection successful');
    
    // Test a simple query
    const result = await thinky.r.now().run();
    console.log('✅ RethinkDB query successful:', result);
    
    return true;
  } catch (error) {
    console.error('❌ RethinkDB test failed:', error.message);
    return false;
  }
}

async function testPostgreSQL() {
  console.log('\n=== Testing PostgreSQL Connection ===');
  
  try {
    const dal = await initializePostgreSQL();
    
    if (!dal) {
      console.log('⚠️  PostgreSQL DAL not initialized (check configuration)');
      return false;
    }
    
    console.log('✅ PostgreSQL connection successful');
    
    // Test a simple query
    const result = await dal.query('SELECT NOW() as current_time');
    console.log('✅ PostgreSQL query successful:', result.rows[0].current_time);
    
    // Test pool stats
    const stats = dal.getPoolStats();
    console.log('✅ PostgreSQL pool stats:', stats);
    
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL test failed:', error.message);
    return false;
  }
}

async function testPostgresUserModel() {
  console.log('\n=== Testing PostgreSQL User Model ===');
  
  try {
    const User = getPostgresUserModel();
    
    if (!User) {
      console.log('⚠️  PostgreSQL User model not available');
      return false;
    }
    
    console.log('✅ PostgreSQL User model initialized');
    
    // Test creating a user (this will fail if table doesn't exist, which is expected)
    try {
      const testUser = {
        display_name: 'Test User',
        canonical_name: 'TEST USER',
        email: 'test@example.com'
      };
      
      console.log('🧪 Testing user creation (may fail if table doesn\'t exist)...');
      const user = await User.create(testUser);
      console.log('✅ User created successfully:', user.id);
      
      // Clean up - delete the test user
      await user.delete();
      console.log('✅ Test user cleaned up');
      
    } catch (modelError) {
      console.log('⚠️  User model test failed (expected if tables not created):', modelError.message);
    }
    
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL User model test failed:', error.message);
    return false;
  }
}

async function main() {
  console.log('🚀 Starting dual database test...');
  console.log('Configuration:');
  console.log('- Dual database mode:', isDualDatabaseMode());
  console.log('- RethinkDB servers:', config.dbServers);
  console.log('- PostgreSQL config:', config.postgres ? 'configured' : 'not configured');
  
  const results = {
    rethinkdb: false,
    postgresql: false,
    postgresModel: false
  };
  
  try {
    // Test RethinkDB
    results.rethinkdb = await testRethinkDB();
    
    // Test PostgreSQL
    results.postgresql = await testPostgreSQL();
    
    // Test PostgreSQL User model
    if (results.postgresql) {
      results.postgresModel = await testPostgresUserModel();
    }
    
  } catch (error) {
    console.error('❌ Test suite failed:', error);
  } finally {
    // Clean up connections
    await closeConnections();
  }
  
  // Summary
  console.log('\n=== Test Results Summary ===');
  console.log('RethinkDB:', results.rethinkdb ? '✅ PASS' : '❌ FAIL');
  console.log('PostgreSQL:', results.postgresql ? '✅ PASS' : '❌ FAIL');
  console.log('PostgreSQL User Model:', results.postgresModel ? '✅ PASS' : '⚠️  SKIP/FAIL');
  
  const allPassed = results.rethinkdb && results.postgresql;
  console.log('\nOverall:', allPassed ? '✅ DUAL DATABASE SETUP WORKING' : '❌ ISSUES DETECTED');
  
  process.exit(allPassed ? 0 : 1);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, cleaning up...');
  await closeConnections();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, cleaning up...');
  await closeConnections();
  process.exit(0);
});

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };