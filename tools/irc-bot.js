/**
 * Simple IRC bot / webapp that listens to lib.reviews new review
 * webhook events at /post and echoes them to IRC.
 *
 * No auth for now; webapp listens only on loopback interface.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
process.env.NODE_CONFIG_DIR = path.join(moduleDir, '../config');

import config from 'config';
import irc from 'irc-upd';
import bodyParser from 'body-parser';
import express from 'express';
import entities from 'entities';

const { decodeHTML } = entities;

const bot = new irc.Client(config.irc.server, config.irc.options.userName, config.irc.options);

const app = express();

bot.once('names', function () {
  // Every thirty seconds, check that the bot is operating under its canonical
  // nickname, and attempt to regain it if not. (NickServ's "regain" command
  // will modify the bot's nickname, if successful.)
  setInterval(function () {
    if (bot.nick !== config.irc.options.userName) {
      bot.say('NickServ', `regain ${config.irc.options.userName} ${config.irc.options.password}`);
    }
  }, 30 * 1000);
});

app.use(bodyParser.json());

app.post('/reviews', function (req, res) {
  const data = req.body.data;
  let url;
  if (Array.isArray(data.thingURLs) && data.thingURLs[0])
    url = data.thingURLs[0];

  let resolvedLabel = resolve(data.thingLabel);
  if (resolvedLabel)
    resolvedLabel = decodeHTML(resolvedLabel);
  const subject = resolvedLabel || url || 'unknown subject';
  const message = `New review of ${subject} by ${data.author} at ${data.reviewURL}`;

  config.irc.options.channels.forEach(function (channel) {
    bot.say(channel, message);
  });

  res.sendStatus(204);
});

app.listen(config.irc.appPort, '127.0.0.1', function () {
  console.log('Listening on port ' + config.irc.appPort);
});

// Quickly resolve multilingual string to English or first non-English language
function resolve(str) {
  if (typeof str !== 'object')
    return undefined;

  const langs = Object.keys(str);
  if (!langs.length)
    return undefined;

  return str.en || str[langs[0]];
}
