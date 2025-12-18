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
    // Get the latest migration filename and total count
    const migrationsBefore = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations ORDER BY executed_at DESC, id DESC'
    );
    t.true(migrationsBefore.rowCount! >= 1, 'at least one migration exists');
    const latestMigration = migrationsBefore.rows[0].filename;
    const countBefore = migrationsBefore.rowCount!;

    await dal.rollback();

    // Verify migration count decreased by 1
    const migrationsAfter = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations'
    );
    t.is(migrationsAfter.rowCount, countBefore - 1, 'migration count decreased by 1');

    // Verify the specific migration was removed
    const rolledBackMigration = await dal.query<{ filename: string }>(
      'SELECT filename FROM migrations WHERE filename = $1',
      [latestMigration]
    );
    t.is(rolledBackMigration.rowCount, 0, 'rolled back migration removed from migrations table');
  } finally {
    await cleanup({ dropSchema: true });
  }
});
