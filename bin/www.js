#!/usr/bin/env node

'use strict';

const config = require('config');

const getApp = require('../app');
const getDB = require('../db').getDB;
const path = require('path');
const greenlock = require('greenlock-express');

async function runWebsite() {
  const db = await getDB();
  const app = await getApp(db);
  const port = normalizePort(process.env.PORT || config.get('devPort'));

  if (app.get('env') == 'production') {
    greenlock.init({
      packageRoot: path.join(__dirname, '..'),

      // contact for security and critical bug notices
      maintainerEmail: config.get('adminEmail'),

      // where to look for configuration
      configDir: path.join(__dirname, '../config/greenlock'),

      // whether or not to run at cloudscale
      cluster: false
    }).serve(app);
  } else {
    app.set('port', port);
    app.listen(port, '127.0.0.1').on('error', onError);
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

function onError(error) {
  if (error.syscall !== 'listen') {
    throw error;
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
