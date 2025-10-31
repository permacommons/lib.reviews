import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'process';

// Suppress unhandled rejection warnings during DAL check
// The check will handle errors gracefully
const rejectionHandler = () => {};
process.on('unhandledRejection', rejectionHandler);

const { checkDALReadinessOrExit } = await import('./helpers/check-dal-readiness.js');

const args = process.argv.slice(2);
if (args.length === 0)
  args.push('--verbose', 'tests/[0-9]*-*.js');

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
  LIBREVIEWS_VITE_DEV_SERVER: process.env.LIBREVIEWS_VITE_DEV_SERVER || 'off',
  NODE_APP_INSTANCE: process.env.NODE_APP_INSTANCE || 'testing',
  NODE_CONFIG_DISABLE_WATCH: process.env.NODE_CONFIG_DISABLE_WATCH || 'Y'
};

// Check DAL readiness before running tests
await checkDALReadinessOrExit();

// Restore normal unhandled rejection behavior
process.off('unhandledRejection', rejectionHandler);

const child = spawn('ava', args, {
  stdio: 'inherit',
  env
});

child.on('exit', (code, signal) => {
  const exitCode = signal ? (128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 0)) : (code ?? 0);
  process.exit(exitCode);
});

child.on('error', async error => {
  console.error('Failed to start AVA:', error);
  process.exit(1);
});
