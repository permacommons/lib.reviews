import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'process';
import { cleanupAllFixtures } from './rethinkdb-cleanup.mjs';

// We wrap AVA so there is exactly one process responsible for standing up and tearing down
// rethinkdb. AVA’s worker model doesn’t offer a global teardown hook, so this wrapper ensures
// we clean fixtures before the suite starts and after any exit (including Ctrl+C).

const args = process.argv.slice(2);
if (args.length === 0)
  args.push('--verbose', 'tests-legacy/*-*.mjs');

process.stdout.write('Cleaning up rethinkdb fixtures …');
await cleanupAllFixtures();
process.stdout.write(' Cleanup complete.\n');

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
  LIBREVIEWS_VITE_DEV_SERVER: process.env.LIBREVIEWS_VITE_DEV_SERVER || 'off'
};

const child = spawn('ava', args, {
  stdio: 'inherit',
  env
});

let shuttingDown = false;

const exitWith = async code => {
  if (shuttingDown)
    return;
  shuttingDown = true;
  process.off('SIGINT', handleSignal);
  process.off('SIGTERM', handleSignal);
  process.stdout.write('\nCleaning up rethinkdb fixtures …');
  try {
    await cleanupAllFixtures();
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
  process.stdout.write(' Cleanup complete.\n');
  process.exit(code);
};

function handleSignal(signal) {
  if (shuttingDown)
    return;
  try {
    child.kill(signal);
  } catch {}
  const code = signal === 'SIGINT' ? 130 : 143;
  exitWith(code);
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

child.on('exit', (code, signal) => {
  const exitCode = signal ? (128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 0)) : (code ?? 0);
  exitWith(exitCode);
});

child.on('error', async error => {
  console.error('Failed to start AVA:', error);
  await exitWith(1);
});
