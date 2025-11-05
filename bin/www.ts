#!/usr/bin/env node

import fs from 'node:fs';
import type { Server as HttpsServer, ServerOptions as HttpsServerOptions } from 'node:https';
import https from 'node:https';
import type { HTTPSConfig } from 'config';
import config from 'config';

import getApp from '../app.ts';
import dbPostgres from '../db-postgres.ts';

type NormalizedPort = number | string | false;

const { getDB } = dbPostgres;

async function runWebsite(): Promise<void> {
  await getDB();
  const app = await getApp();

  const httpsConfig: HTTPSConfig | null = config.has('https')
    ? config.get<HTTPSConfig>('https')
    : null;
  const httpsEnabled = app.get('env') === 'production' && httpsConfig?.enabled === true;

  if (httpsEnabled && httpsConfig) {
    const port = normalizePort(process.env.PORT ?? httpsConfig.port ?? 443);
    const host = httpsConfig.host ?? '0.0.0.0';
    const credentials = loadHttpsCredentials(httpsConfig);

    const listenPort = ensureValidPort(port);
    app.set('port', listenPort);
    const server = https.createServer(credentials, app);

    const httpsServer =
      typeof listenPort === 'number' ? server.listen(listenPort, host) : server.listen(listenPort);

    httpsServer.on('error', error => onError(error as NodeJS.ErrnoException, listenPort));
    setupHttpsReload(server);
  } else {
    const port = normalizePort(process.env.PORT ?? config.get('devPort'));
    const listenPort = ensureValidPort(port);

    app.set('port', listenPort);
    const httpServer =
      typeof listenPort === 'number' ? app.listen(listenPort, '127.0.0.1') : app.listen(listenPort);

    httpServer.on('error', error => onError(error as NodeJS.ErrnoException, listenPort));
  }
}

runWebsite().catch((error: unknown) => {
  console.error('Could not start lib.reviews web service. An error occurred:');
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});

/**
 * Normalize a port into a number, string, or false.
 */
function normalizePort(value: string | number | undefined): NormalizedPort {
  if (typeof value === 'number') {
    return value >= 0 ? value : false;
  }

  if (value === undefined) {
    return false;
  }

  const port = Number.parseInt(value, 10);

  if (Number.isNaN(port)) return value; // named pipe

  if (port >= 0) return port; // port number

  return false;
}

function ensureValidPort(port: NormalizedPort): number | string {
  if (port === false) {
    throw new Error('Invalid port configuration resolved to a negative value.');
  }
  return port;
}

/**
 * Event listener for HTTP server "error" event.
 */
function onError(error: NodeJS.ErrnoException, port: number | string): never {
  if (error.syscall !== 'listen') {
    throw error;
  }

  // handle specific listen errors with friendly messages
  switch (error.code) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: process.exit terminates execution
    case 'EACCES':
      console.error(`Port ${port} requires elevated privileges`);
      process.exit(1);
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: process.exit terminates execution
    case 'EADDRINUSE':
      console.error(`Port ${port} is already in use`);
      process.exit(1);
    default:
      throw error;
  }
}

function loadHttpsCredentials(httpsConfig: HTTPSConfig): HttpsServerOptions {
  if (!httpsConfig.keyPath || !httpsConfig.certPath) {
    throw new Error('HTTPS is enabled but keyPath or certPath is not configured.');
  }

  try {
    const credentials: HttpsServerOptions = {
      key: fs.readFileSync(httpsConfig.keyPath),
      cert: fs.readFileSync(httpsConfig.certPath),
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

function setupHttpsReload(server: HttpsServer): void {
  if (typeof server.setSecureContext !== 'function') {
    return;
  }

  process.on('SIGHUP', () => {
    console.info('[HTTPS] Received SIGHUP; reloading TLS configuration.');

    try {
      if (!config.has('https')) {
        console.warn('[HTTPS] Reload skipped: `https` configuration block is missing.');
        return;
      }

      const httpsConfig = config.get<HTTPSConfig>('https');

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
