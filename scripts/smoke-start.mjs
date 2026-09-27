#!/usr/bin/env node
/**
 * Production startup smoke test.
 *
 * Starts the built server (build/server/bin/www.js) with NODE_ENV=production
 * on a free port, polls GET / until it responds with 200, and fails with the
 * server's output if the process exits or the timeout elapses. The server is
 * always stopped afterwards.
 *
 * Requires `npm run build:deploy` to have been run first.
 *
 * Usage: node scripts/smoke-start.mjs [--timeout <seconds>]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = path.join(repoRoot, 'build/server/bin/www.js');

const timeoutFlag = process.argv.indexOf('--timeout');
const timeoutSeconds = timeoutFlag === -1 ? 60 : Number(process.argv[timeoutFlag + 1]);
const pollIntervalMs = 500;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killTimer);
}

async function main() {
  if (!existsSync(entryPoint)) {
    console.error(`Smoke test failed: ${entryPoint} not found. Run "npm run build:deploy" first.`);
    return 1;
  }

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}/`;
  const output = [];

  console.log(`Starting ${path.relative(repoRoot, entryPoint)} on port ${port}…`);
  const child = spawn(process.execPath, [entryPoint], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => output.push(chunk));

  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const fail = reason => {
    console.error(`Smoke test failed: ${reason}`);
    console.error('--- server output ---');
    console.error(Buffer.concat(output).toString().trimEnd() || '(no output)');
    console.error('--- end server output ---');
    return 1;
  };

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = 'no response';
  try {
    while (Date.now() < deadline) {
      if (exitInfo) {
        return fail(
          `server exited before serving ${url} (code ${exitInfo.code}, signal ${exitInfo.signal})`
        );
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (response.status === 200) {
          console.log(`GET ${url} returned 200. Production startup smoke test passed.`);
          return 0;
        }
        lastStatus = `HTTP ${response.status}`;
      } catch (error) {
        lastStatus = error.cause?.code ?? error.message;
      }
      await sleep(pollIntervalMs);
    }
    return fail(`GET ${url} did not return 200 within ${timeoutSeconds}s (last: ${lastStatus})`);
  } finally {
    await stopServer(child);
  }
}

process.exitCode = await main();
