import test from 'ava';

import { createTestHarness } from '../bootstrap/dal.ts';

test('rollback reverts last migration using down script', async t => {
  const { dal, cleanup } = await createTestHarness({
    schemaName: 'test_migration_rollback',
    schemaNamespace: 'test_migration_rollback.',
    autoMigrate: true,
    registerModels: false,
  });

  try {
    const tableBefore = await dal.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'account_requests'"
    );
    t.true(tableBefore.rowCount === 1, 'account_requests table exists after migrate');

    const migrationsBefore = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations ORDER BY executed_at DESC, id DESC'
    );
    t.true(
      migrationsBefore.rows.some(row => row.filename === '003_account_requests.sql'),
      'latest migration recorded before rollback'
    );

    await dal.rollback();

    const tableAfter = await dal.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'account_requests'"
    );
    t.true(tableAfter.rowCount === 0, 'account_requests table removed after rollback');

    const migrationsAfter = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations WHERE filename = $1',
      ['003_account_requests.sql']
    );
    t.is(migrationsAfter.rowCount, 0, 'rolled back migration removed from migrations table');
  } finally {
    await cleanup({ dropSchema: true });
  }
});
