'use strict';

import fs from 'fs/promises';
import path from 'path';

export const fixturesRoot = path.join(process.cwd(), 'tests', 'fixtures');
export const fixturePrefix = 'rethinkdb_data_testing_';
export const pidSuffix = '.pid';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExit(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() <= deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH')
        return;
      throw error;
    }
    await sleep(100);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH')
      throw error;
  }
}

async function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH')
      return;
    throw error;
  }
  await waitForExit(pid);
}

async function killFromPidFile(pidFile) {
  try {
    const pidString = await fs.readFile(pidFile, 'utf8');
    const pid = Number.parseInt(pidString, 10);
    if (!Number.isNaN(pid))
      await killPid(pid);
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error(`Failed to read pid file ${pidFile}:`, error);
  }
}

export async function removeFixtureFiles(base) {
  await fs.rm(path.join(fixturesRoot, `${base}${pidSuffix}`), { force: true });
  await fs.rm(path.join(fixturesRoot, base), { recursive: true, force: true });
}

export async function cleanupFixture(base) {
  await killFromPidFile(path.join(fixturesRoot, `${base}${pidSuffix}`));
  await removeFixtureFiles(base);
}

export async function cleanupAllFixtures() {
  let entries;
  try {
    entries = await fs.readdir(fixturesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT')
      return;
    throw error;
  }

  const bases = new Set();
  for (const entry of entries) {
    if (!entry.name.startsWith(fixturePrefix))
      continue;
    if (entry.isDirectory())
      bases.add(entry.name);
    else if (entry.isFile() && entry.name.endsWith(pidSuffix))
      bases.add(entry.name.slice(0, -pidSuffix.length));
  }

  await Promise.all(Array.from(bases, cleanupFixture));
}

const cleanupCallbacks = globalThis.__rethinkdbCleanupCallbacks || new Set();

let signalsRegistered = globalThis.__rethinkdbSignalsRegistered ?? false;
export function registerGlobalSignalHandlers(onCleanupComplete) {
  if (typeof onCleanupComplete === 'function')
    cleanupCallbacks.add(onCleanupComplete);

  if (signalsRegistered)
    return;

  const handler = async signal => {
    try {
      await cleanupAllFixtures();
      for (const callback of cleanupCallbacks) {
        try {
          await callback();
        } catch (error) {
          console.error('Failed to finalize rethinkdb cleanup:', error);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup RethinkDB fixtures on shutdown:', error);
    } finally {
      const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0;
      process.exit(code);
    }
  };

  ['SIGINT', 'SIGTERM'].forEach(signal => {
    process.once(signal, () => {
      handler(signal).catch(error => {
        console.error('Unhandled cleanup error:', error);
        process.exit(1);
      });
      setTimeout(() => handler(signal), 50).catch(error => {
        console.error('Unhandled cleanup error (retry):', error);
        process.exit(1);
      });
    });
  });

  signalsRegistered = true;
  globalThis.__rethinkdbSignalsRegistered = true;
  globalThis.__rethinkdbCleanupCallbacks = cleanupCallbacks;
}
