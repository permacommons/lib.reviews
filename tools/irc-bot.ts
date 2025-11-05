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

import bodyParser from 'body-parser';
import config from 'config';
import type { IRCConfig } from 'config';
import express from 'express';
import type { Request, Response } from 'express';
import irc from 'irc-upd';
import { decodeHTML } from 'entities';

interface ReviewWebhookPayload {
  thingURLs?: string[];
  thingLabel?: Record<string, string>;
  author: string;
  reviewURL: string;
}

interface ReviewWebhookBody {
  data: ReviewWebhookPayload;
}

type MultilingualLabel = Record<string, string>;

const ircConfig: IRCConfig = config.get<IRCConfig>('irc');
const bot = new irc.Client(ircConfig.server, ircConfig.options.userName, ircConfig.options);

const app = express();

bot.once('names', () => {
  // Every thirty seconds, check that the bot is operating under its canonical
  // nickname, and attempt to regain it if not. (NickServ's "regain" command
  // will modify the bot's nickname, if successful.)
  setInterval(() => {
    if (bot.nick !== ircConfig.options.userName) {
      bot.say('NickServ', `regain ${ircConfig.options.userName} ${ircConfig.options.password}`);
    }
  }, 30 * 1000);
});

app.use(bodyParser.json());

app.post(
  '/reviews',
  (req: Request<Record<string, never>, unknown, ReviewWebhookBody>, res: Response) => {
    const { data } = req.body;

    const url = Array.isArray(data.thingURLs) && data.thingURLs[0] ? data.thingURLs[0] : undefined;

    let resolvedLabel = resolveLabel(data.thingLabel);
    if (resolvedLabel) {
      resolvedLabel = decodeHTML(resolvedLabel);
    }

    const subject = resolvedLabel ?? url ?? 'unknown subject';
    const message = `New review of ${subject} by ${data.author} at ${data.reviewURL}`;

    ircConfig.options.channels.forEach(channel => {
      bot.say(channel, message);
    });

    res.sendStatus(204);
  }
);

app.listen(ircConfig.appPort, '127.0.0.1', () => {
  console.log(`Listening on port ${ircConfig.appPort}`);
});

// Quickly resolve multilingual string to English or first non-English language
function resolveLabel(label: MultilingualLabel | undefined): string | undefined {
  if (!label) return undefined;

  const langs = Object.keys(label);
  if (langs.length === 0) return undefined;

  return label.en ?? label[langs[0]];
}
