/**
 * DAL Readiness Check for Tests
 *
 * This script checks if the PostgreSQL DAL is available and properly configured
 * before running tests. If the DAL is not available, it exits with an error.
 *
 * This eliminates the need for per-test skipping logic throughout the test suite.
 */

import { createTestHarness } from '../../bootstrap/dal.js';
import config from 'config';

/**
 * Check if the DAL can be initialized successfully
 * @returns {Promise<boolean>} true if DAL is ready, false otherwise
 */
export async function checkDALReadiness() {
  try {
    // Safety check: ensure we're not pointed at the production database
    if (config.has('postgres')) {
      const pgConfig = config.get('postgres');
      if (pgConfig.database === 'libreviews') {
        console.error('\n❌ SAFETY CHECK FAILED\n');
        console.error('Test configuration is pointing to production database "libreviews"!');
        console.error('Tests must use a dedicated test database (e.g., "libreviews_test").');
        console.error('\nCheck your configuration in config/development-testing.json5\n');
        return false;
      }
    }

    // This will trigger db-postgres auto-initialization
    // We need to catch both sync and async errors
    // Try to create a test harness with a temporary schema
    // This will automatically handle migrations
    const harness = await createTestHarness({
      schemaName: 'test_readiness_check',
      schemaNamespace: 'test_readiness_check.',
      registerModels: false,
      autoMigrate: true
    });

    // Clean up immediately
    await harness.cleanup({ dropSchema: true });

    return true;
  } catch (error) {
    console.error('\n❌ PostgreSQL DAL is not available\n');

    // Provide specific guidance for connection errors
    if (error.code === 'ECONNREFUSED') {
      console.error('Connection refused - PostgreSQL is not running or not accessible.\n');
      console.error('Make sure PostgreSQL is running and accepting connections.');
    } else {
      console.error(`Error: ${error.message}\n`);
      console.error('Common fixes:');
      console.error('  • Check PostgreSQL is running');
      console.error('  • Verify config/development-testing.json5');
      console.error('  • Ensure database exists and user has proper permissions');
    }

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }

    console.error('');
    return false;
  }
}

/**
 * Check DAL readiness and exit if not ready (for use in scripts)
 */
export async function checkDALReadinessOrExit() {
  const isReady = await checkDALReadiness();

  if (!isReady) {
    console.error('❌ Tests cannot run without a valid PostgreSQL connection.\n');
    process.exit(1);
  }

  console.log('✅ PostgreSQL DAL is ready\n');
}
