import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'process';

const args = process.argv.slice(2);
if (args.length === 0)
  args.push('--verbose', 'tests-postgres/[0-9]*-*.mjs');

const manifestPath = resolve(process.cwd(), 'build', 'vite', '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  process.stdout.write(`Missing Vite manifest at ${manifestPath}. Running "npm run build"…\n`);
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const buildResult = spawnSync(npmCommand, ['run', 'build'], {
    stdio: 'inherit',
    env: process.env
  });

  if (buildResult.status !== 0) {
    const exitCode = buildResult.status ?? 1;
    process.stderr.write('\n`npm run build` failed; aborting test run.\n');
    process.exit(exitCode);
  }

  if (!existsSync(manifestPath)) {
    process.stderr.write(`\nVite manifest still missing after build step (${manifestPath}).\n`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  NODE_APP_INSTANCE: 'testing',
  LIBREVIEWS_VITE_DEV_SERVER: process.env.LIBREVIEWS_VITE_DEV_SERVER || 'off',
  LIBREVIEWS_SKIP_RETHINK: process.env.LIBREVIEWS_SKIP_RETHINK || '1'
};

const child = spawn('ava', args, {
  stdio: 'inherit',
  env
});

import config from 'config';
import pg from 'pg';

child.on('exit', async (code, signal) => {
  const dbConfig = config.get('postgres');
  const pool = new pg.Pool(dbConfig);
  try {
    const client = await pool.connect();
    const { rows } = await client.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'test_%'
    `);
    for (const { schema_name } of rows) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema_name} CASCADE`);
    }
    client.release();
  } catch (error) {
    console.error('Failed to clean up test schemas:', error);
  } finally {
    await pool.end();
    const exitCode = signal ? (128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 0)) : (code ?? 0);
    process.exit(exitCode);
  }
});

child.on('error', async error => {
  console.error('Failed to start AVA:', error);
  process.exit(1);
});
