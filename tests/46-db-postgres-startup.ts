import { readdir } from 'node:fs/promises';
import test from 'ava';

// Importing db-postgres starts connecting and migrating right away, as it does
// when bin/www.ts starts the web service.
const { default: dbPostgres } = await import('../db-postgres.ts');

const getSharedDAL = () => (dbPostgres as unknown as { dal: unknown }).dal;
// The DAL class reports this; the DataAccessLayer interface doesn't declare it
const isConnected = (dal: unknown) => (dal as { isConnected(): boolean }).isConnected();

test.serial('the shared DAL is only exposed once it is connected and migrated', async t => {
  // Connecting requires I/O, so the attempt started by the import is still in flight
  t.is(getSharedDAL(), null, 'not exposed while connecting');

  const dal = await dbPostgres.getDB();

  t.true(isConnected(dal), 'getDB() resolves with a connected DAL');
  t.is(getSharedDAL(), dal);
  t.is(await dbPostgres.getPostgresDAL(), dal, 'callers share one DAL');
  t.is(await dbPostgres.initializePostgreSQL(), dal);

  const migrationFiles = (await readdir('migrations')).filter(name => name.endsWith('.sql'));
  const result = await dal.query('SELECT filename FROM migrations');
  const applied = result.rows.map(row => row.filename);
  t.deepEqual(
    migrationFiles.filter(name => !applied.includes(name)),
    [],
    'all migrations ran before getDB() resolved'
  );
});

test.serial('closeConnection() closes the shared DAL', async t => {
  const dal = await dbPostgres.getDB();

  await dbPostgres.closeConnection();

  t.false(isConnected(dal));
  t.is(getSharedDAL(), null);
});
