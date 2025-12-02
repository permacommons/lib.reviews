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
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'password_reset_tokens'"
    );
    t.true(tableBefore.rowCount === 1, 'password_reset_tokens table exists after migrate');

    const migrationsBefore = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations ORDER BY executed_at DESC, id DESC'
    );
    t.true(
      migrationsBefore.rows.some(row => row.filename === '002_password_reset.sql'),
      'latest migration recorded before rollback'
    );

    await dal.rollback();

    const tableAfter = await dal.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'password_reset_tokens'"
    );
    t.true(tableAfter.rowCount === 0, 'password_reset_tokens table removed after rollback');

    const migrationsAfter = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations WHERE filename = $1',
      ['002_password_reset.sql']
    );
    t.is(migrationsAfter.rowCount, 0, 'rolled back migration removed from migrations table');
  } finally {
    await cleanup({ dropSchema: true });
  }
});
