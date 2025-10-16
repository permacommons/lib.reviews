import { spawn } from 'child_process';
import process from 'process';
import { cleanupAllFixtures } from './rethinkdb-cleanup.mjs';

// We wrap AVA so there is exactly one process responsible for standing up and tearing down
// rethinkdb. AVA’s worker model doesn’t offer a global teardown hook, so this wrapper ensures
// we clean fixtures before the suite starts and after any exit (including Ctrl+C).

const args = process.argv.slice(2);
if (args.length === 0)
  args.push('--verbose', 'tests/*-*.mjs');

process.stdout.write('Cleaning up rethinkdb fixtures …');
await cleanupAllFixtures();
process.stdout.write(' Cleanup complete.\n');

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
