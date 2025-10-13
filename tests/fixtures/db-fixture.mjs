import childProcessPromise from 'child-process-promise';
import { logNotice, logOK } from '../helpers/test-helpers.mjs';
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs/promises';
import { cleanupFixture, pidSuffix } from '../helpers/rethinkdb-cleanup.mjs';

const require = createRequire(import.meta.url);
const { exec, spawn } = childProcessPromise;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DBFixture {

  constructor() {

    if (!process.env.NODE_APP_INSTANCE)
      throw new Error('Set NODE_APP_INSTANCE to determine configuration and database name.');

    this.loaded = false;
    this.dbLog = [];
    this.models = [];
    // Sanitize name
    let dbName = 'rethinkdb_data_' + process.env.NODE_APP_INSTANCE.replace(/[^a-zA-Z0-9]/g, '_');
    this.filename = path.join(__dirname, dbName);
    this.pidFile = path.join(__dirname, `${dbName}${pidSuffix}`);
  }

  async bootstrap(models) {

    process.env.NODE_CONFIG_DIR = path.join(__dirname, '../../config');

    logNotice(`Loading config for instance ${process.env.NODE_APP_INSTANCE} from ${process.env.NODE_CONFIG_DIR}.`);

    const config = require('config');

    logNotice('Starting up RethinkDB.');

    const baseName = path.basename(this.filename);
    // Ensure we start from a clean slate; removes any leftover pid/data directories from
    // previous runs (e.g., tests interrupted via Ctrl+C).
    await cleanupFixture(baseName);
    await fs.mkdir(path.dirname(this.filename), { recursive: true });
    try {
      await exec(`rethinkdb create -d ${this.filename}`);
    } catch (error) {
      console.error(chalk.red('Failed to initialize RethinkDB data directory.'));
      throw error;
    }

    this.dbProcess = spawn('rethinkdb', ['-d', this.filename, '--driver-port', String(config.dbServers[0].port), '--cluster-port', String(config.dbServers[0].port + 1000), '--no-http-admin']).childProcess;
    await fs.writeFile(this.pidFile, String(this.dbProcess.pid));

    try {
      await this.dbReady();
    } catch (error) {
      console.error(chalk.red('RethinkDB exited unexpectedly.'));
      if (this.dbLog.length) {
        console.error('It had the following to say for itself:');
        console.error(this.dbLog.join('\n'));
      }
      process.exit();
    }
    this.db = require('../../db');
    logOK('Database is up and running.');
    logNotice('Loading models.');
    let readyPromises = [];
    for (let m of models) {
      this.models[m.name] = require(`../../models/${m.file}`);
      readyPromises.push(this.models[m.name].ready());
    }
    logNotice('Waiting for tables and indices to be created by Thinky.');
    // Tables need to be created
    await Promise.all(readyPromises);
    logOK('Ready to go, starting tests. 🚀\n');
    this.loaded = true;
  }


  // Gracefully tear down the child rethinkdb process and its pooled connections.
  async cleanup() {
    logNotice('Cleaning up.');
    if (this.db) {
      try {
        await this.db.r.getPoolMaster().drain();
      } catch (error) {
        console.error(chalk.red('Failed to drain RethinkDB connection pool.'));
        console.error(error);
      }
      // Prevent subsequent tests from reusing stale handles.
      logOK('RethinkDB connection pool drained.');
      this.db = null;
    }
    if (this.dbProcess) {
      logNotice('Killing test database process.');
      // Graceful shutdown keeps rethinkdb from spewing errors about unclean exits.
      await this.killDB();
      this.dbProcess = null;
      logOK('Test database process terminated.');
    }
    // Data directory removal is handled by the global cleanup logic.
  }

  dbReady() {
    return new Promise((resolve, reject) => {
      this.dbProcess.stdout.on('data', buffer => {
        let str = buffer.toString();
        this.dbLog.push(str);
        if (/Server ready/.test(str))
          resolve();
      });
      this.dbProcess.stderr.on('data', buffer => {
        let str = buffer.toString();
        this.dbLog.push(str);
      });
      this.dbProcess.on('close', reject);
    });
  }

  killDB() {
    return new Promise((resolve, reject) => {
      const proc = this.dbProcess;
      if (!proc) {
        resolve();
        return;
      }
      proc.once('close', resolve);
      proc.once('error', reject);
      if (!proc.kill('SIGTERM')) {
        resolve();
      }
    });
  }

}
export const createDBFixture = () => new DBFixture();
