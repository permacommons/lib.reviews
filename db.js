'use strict';
const Thinky = require('./orm');
const config = require('config');
const debug = require('./util/debug');

const thinky = Thinky({
  servers: config.dbServers,
  db: config.dbName,
  user: config.dbUser,
  password: config.dbPassword,
  silent: true
});

thinky.r.getPoolMaster().on('healthy', healthy => {
  if (healthy) {
    debug.db('RethinkDB database pool is healthy.');
  } else {
    debug.db('RethinkDB database pool is not healthy. Is the database up?');
  }
});

let droppingMsgs, lastMsg;
thinky.r.getPoolMaster().on('log', msg => {

  if (lastMsg !== msg) {
    debug.db(msg);
    droppingMsgs = false;
  } else {
    if (!droppingMsgs)
      debug.db('Additional identical message(s) received, ignoring.');
    droppingMsgs = true;
  }
  lastMsg = msg;

});

thinky.r.getPoolMaster()._flushErrors = () => {
  // Overriding default behavior in driver -- pool master does not gracefully
  // handle inability to (re-)connect and spews errors
};

thinky.getDB = () => {
  let connected = false;
  return new Promise(resolve => {
    debug.db('Waiting for database connection.');
    thinky.r.getPoolMaster().on('available-size', size => {
      if (size === 1 && !connected) {
        connected = true;
        debug.db('Connection to RethinkDB established.');
        resolve(thinky);
      }
    });
  });
};


module.exports = thinky;
