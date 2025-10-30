#!/usr/bin/env node

import config from 'config';
import fs from 'node:fs';
import https from 'node:https';

import getApp from '../app.mjs';
import dbPostgres from '../db-postgres.js';

const { getDB } = dbPostgres;

async function runWebsite() {
  await getDB();
  const app = await getApp();

  const httpsConfig = config.has('https') ? config.get('https') : {};
  const httpsEnabled = app.get('env') === 'production' && httpsConfig.enabled;

  if (httpsEnabled) {
    const port = normalizePort(process.env.PORT || httpsConfig.port || 443);
    const host = httpsConfig.host || '0.0.0.0';
    const credentials = loadHttpsCredentials(httpsConfig);

    app.set('port', port);
    const server = https.createServer(credentials, app);

    server.listen(port, host).on('error', error => onError(error, port));
    setupHttpsReload(server);
  } else {
    const port = normalizePort(process.env.PORT || config.get('devPort'));

    app.set('port', port);
    app.listen(port, '127.0.0.1').on('error', error => onError(error, port));
  }
}

runWebsite().catch(error => {
  console.error('Could not start lib.reviews web service. An error occurred:');
  console.error(error.stack);
  process.exit(1);
});

/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val) {
  const port = parseInt(val, 10);

  if (isNaN(port))
    return val; // named pipe

  if (port >= 0)
    return port; // port number

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error, port) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  if (port != null) {
    error.port = port;
  }

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(`Port ${error.port} requires elevated privileges`);
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(`Port ${error.port} is already in use`);
      process.exit(1);
      break;
    default:
      throw error;
  }
}

function loadHttpsCredentials(httpsConfig) {
  if (!httpsConfig.keyPath || !httpsConfig.certPath) {
    throw new Error('HTTPS is enabled but keyPath or certPath is not configured.');
  }

  try {
    const credentials = {
      key: fs.readFileSync(httpsConfig.keyPath),
      cert: fs.readFileSync(httpsConfig.certPath)
    };

    if (httpsConfig.caPath) {
      credentials.ca = fs.readFileSync(httpsConfig.caPath);
    }

    return credentials;
  } catch (error) {
    console.error('Failed to load TLS certificates. Please verify the configured paths.');
    throw error;
  }
}

function setupHttpsReload(server) {
  if (!server || typeof server.setSecureContext !== 'function') {
    return;
  }

  process.on('SIGHUP', () => {
    console.info('[HTTPS] Received SIGHUP; reloading TLS configuration.');

    try {
      if (!config.has('https')) {
        console.warn('[HTTPS] Reload skipped: `https` configuration block is missing.');
        return;
      }

      const httpsConfig = config.get('https');

      if (!httpsConfig.enabled) {
        console.warn('[HTTPS] Reload skipped: HTTPS is disabled in configuration.');
        return;
      }

      const credentials = loadHttpsCredentials(httpsConfig);
      server.setSecureContext(credentials);
      console.info('[HTTPS] TLS certificates reloaded successfully.');
    } catch (error) {
      console.error('[HTTPS] Failed to reload TLS certificates:', error);
    }
  });
}
