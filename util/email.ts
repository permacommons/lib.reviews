import { promises as fs } from 'node:fs';
import path from 'node:path';

import config from 'config';
import formData from 'form-data';
import hbs from 'hbs';
import i18n from 'i18n';
import Mailgun from 'mailgun.js';
import type { Interfaces, APIErrorType as MailgunApiError } from 'mailgun.js/definitions';

import debug from './debug.ts';

type MailgunClient = Interfaces.IMailgunClient | null;

const mailgunFactory = new Mailgun(formData);
let mailgunClient: MailgunClient = null;

function getMailgunClient(): MailgunClient {
  if (mailgunClient) return mailgunClient;
  if (!config.get<boolean>('email.enabled')) return null;
  if (config.get<string>('email.provider') !== 'mailgun') return null;

  const apiKey = config.get('email.mailgun.apiKey') as string;
  const url = config.get('email.mailgun.url') as string;
  if (!apiKey) {
    debug.util('Email not sent - Mailgun API key missing');
    return null;
  }

  mailgunClient = mailgunFactory.client({
    username: 'api',
    key: apiKey,
    url,
  });

  return mailgunClient;
}

function ensureEmailEnabled(feature: string): boolean {
  if (config.get<boolean>('email.enabled')) return true;
  debug.util(`${feature} not sent - email feature disabled in config`);
  return false;
}

function ensureAccountRequestsEnabled(feature: string): boolean {
  if (config.get<boolean>('accountRequests.enabled')) return true;
  debug.util(`${feature} not sent - feature disabled`);
  return false;
}

function getMailgunClientOrLog(feature: string): MailgunClient {
  const client = getMailgunClient();
  if (!client) debug.error(`${feature} not sent - Mailgun client unavailable`);
  return client;
}

/**
 * Send a password reset email when email support is enabled.
 *
 * @param to - Recipient email address
 * @param resetToken - Token to embed in the reset URL
 * @param language - Optional language code to pick templates
 */
export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  language: string = 'en'
): Promise<void> {
  if (!ensureEmailEnabled('Password reset email')) return;

  const client = getMailgunClientOrLog('Password reset email');
  if (!client) return;

  const qualifiedURL = config.get('qualifiedURL') as string;
  const resetURL = new URL(`reset-password/${resetToken}`, qualifiedURL).toString();
  const expirationHours = config.get<number>('passwordReset.tokenExpirationHours') ?? 3;

  const subject = getEmailSubject('password reset email subject', language);
  const { text, html } = await loadEmailTemplate('password-reset', language, {
    resetURL,
    expirationHours,
  });

  try {
    await client.messages.create(config.get('email.mailgun.domain') as string, {
      from: config.get('email.mailgun.from') as string,
      to: [to],
      subject,
      text,
      html,
    });
  } catch (error) {
    debug.error(`Failed to send password reset email: ${formatMailgunError(error)}`);
  }
}

/**
 * Notify moderators when a new account request is submitted.
 *
 * Note: Currently sends the same language to all moderators since user language
 * preferences are stored in cookies, not the database. Should be called with 'en'.
 *
 * @param language - Language code for email localization (defaults to 'en')
 */
export async function sendAccountRequestNotification(language: string = 'en'): Promise<void> {
  if (!ensureEmailEnabled('Account request notification')) return;
  if (!ensureAccountRequestsEnabled('Account request notification')) return;

  const client = getMailgunClientOrLog('Account request notification');
  if (!client) return;

  const User = (await import('../models/user.ts')).default;
  const moderators = await User.filterWhere({ isSiteModerator: true })
    .includeSensitive(['email'])
    .run();
  const moderatorsWithEmail = moderators.filter(m => m.email);

  if (moderatorsWithEmail.length === 0) {
    debug.util('No moderators with email addresses found');
    return;
  }

  const qualifiedURL = config.get('qualifiedURL') as string;
  const manageURL = new URL('actions/manage-requests', qualifiedURL).toString();

  try {
    const subject = getEmailSubject('account request notification subject', language);
    const { text, html } = await loadEmailTemplate('account-request-notification', language, {
      manageURL,
    });

    for (const moderator of moderatorsWithEmail) {
      try {
        await client.messages.create(config.get('email.mailgun.domain') as string, {
          from: config.get('email.mailgun.from') as string,
          to: [moderator.email as string],
          subject,
          text,
          html,
        });
      } catch (error) {
        debug.error(
          `Failed to send account request notification to ${moderator.email}: ${formatMailgunError(error)}`
        );
      }
    }
  } catch (error) {
    debug.error(`Failed to send account request notifications: ${formatMailgunError(error)}`);
  }
}

/**
 * Send invite code to approved account requester.
 *
 * @param to - Email address of the requester
 * @param inviteCode - Invite link UUID for registration
 * @param language - Language code for email localization (defaults to 'en')
 */
export async function sendAccountRequestApproval(
  to: string,
  inviteCode: string,
  language: string = 'en'
): Promise<void> {
  if (!ensureEmailEnabled('Account approval email')) return;
  if (!ensureAccountRequestsEnabled('Account approval email')) return;

  const client = getMailgunClientOrLog('Account approval email');
  if (!client) return;

  const qualifiedURL = config.get('qualifiedURL') as string;
  const registerURL = new URL(`register/${inviteCode}`, qualifiedURL).toString();

  try {
    const subject = getEmailSubject('account request approval subject', language);
    const { text, html } = await loadEmailTemplate('account-request-approval', language, {
      registerURL,
    });

    await client.messages.create(config.get('email.mailgun.domain') as string, {
      from: config.get('email.mailgun.from') as string,
      to: [to],
      subject,
      text,
      html,
    });
  } catch (error) {
    debug.error(`Failed to send account request approval: ${formatMailgunError(error)}`);
  }
}

/**
 * Send rejection email to account requester (optional).
 *
 * @param to - Email address of the requester
 * @param rejectionReason - Reason for rejection to include in email
 * @param language - Language code for email localization (defaults to 'en')
 */
export async function sendAccountRequestRejection(
  to: string,
  rejectionReason: string,
  language: string = 'en'
): Promise<void> {
  if (!ensureEmailEnabled('Account rejection email')) return;
  if (!ensureAccountRequestsEnabled('Account rejection email')) return;

  const client = getMailgunClientOrLog('Account rejection email');
  if (!client) return;

  try {
    const subject = getEmailSubject('account request rejection subject', language);
    const { text, html } = await loadEmailTemplate('account-request-rejection', language, {
      rejectionReason,
    });

    await client.messages.create(config.get('email.mailgun.domain') as string, {
      from: config.get('email.mailgun.from') as string,
      to: [to],
      subject,
      text,
      html,
    });
  } catch (error) {
    debug.error(`Failed to send account request rejection: ${formatMailgunError(error)}`);
  }
}

function normalizeLanguage(language: string): string {
  const supportedLanguages = ['en', 'de'];
  return supportedLanguages.includes(language) ? language : 'en';
}

function getEmailSubject(subjectKey: string, language: string): string {
  const lang = normalizeLanguage(language);
  return i18n.__({ phrase: subjectKey, locale: lang });
}

async function loadEmailTemplate(
  templateName: string,
  language: string,
  vars: Record<string, string | number>
): Promise<{ text: string; html: string }> {
  const lang = normalizeLanguage(language);

  // Load unified templates (no language suffix)
  const textTemplateSource = await readTemplate(`${templateName}.txt`);
  const htmlTemplateSource = await readTemplate(`${templateName}.hbs`);

  // Compile templates with Handlebars
  const textTemplate = hbs.handlebars.compile(textTemplateSource);
  const htmlTemplate = hbs.handlebars.compile(htmlTemplateSource);

  const translate = (phrase: string, ...args: (string | number)[]) =>
    i18n.__({ phrase, locale: lang }, ...(args as string[]));

  // Create context with template vars and i18n locale
  const context = {
    ...vars,
    locale: lang,
    // Add i18n helper functions to context
    __: (phrase: string, ...args: (string | number)[]) =>
      new hbs.handlebars.SafeString(translate(phrase, ...(args as string[]))),
  };

  // Render templates
  const compiledText = textTemplate(context);
  const compiledHtml = htmlTemplate(context);

  return { text: compiledText, html: compiledHtml };
}

async function readTemplate(fileName: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), 'views/email', fileName),
    path.resolve(process.cwd(), 'build/server/views/email', fileName),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch {
      // try next candidate
    }
  }

  throw new Error(`Email template not found: ${fileName}`);
}

/**
 * Basic health check for Mailgun configuration.
 *
 * @returns True when the client can query domains; false otherwise
 */
export async function testEmailConfiguration(): Promise<boolean> {
  if (!config.get<boolean>('email.enabled')) return false;

  const client = getMailgunClient();
  if (!client) return false;

  try {
    await client.domains.list();
    return true;
  } catch (error) {
    debug.error('Mailgun configuration error:', error);
    return false;
  }
}

/**
 * Normalize Mailgun errors into a single loggable string.
 *
 * @param error - Error object thrown by mailgun.js (or unknown)
 * @returns Human-readable description including status, details, and stack when available
 */
export function formatMailgunError(error: unknown): string {
  if (isMailgunApiError(error)) {
    const parts = [`MailgunAPIError: ${error.message}`, `status=${error.status}`];
    if (error.details) parts.push(`details=${error.details}`);
    if (error.stack) parts.push(`stack=${error.stack}`);
    return parts.join(' | ');
  }

  if (error instanceof Error) {
    const err = error as unknown as Record<string, unknown>;
    const status = err.status ?? err.statusCode;
    const code = err.code;
    const detail = err.detail ?? err.details;
    const parts = [`${error.name}: ${error.message}`];
    if (status !== undefined) parts.push(`status=${String(status)}`);
    if (code !== undefined) parts.push(`code=${String(code)}`);
    if (detail !== undefined) {
      try {
        parts.push(`details=${JSON.stringify(detail)}`);
      } catch {
        // ignore serialization failures
      }
    }
    if (error.stack) parts.push(`stack=${error.stack}`);
    return parts.join(' | ');
  }

  if (typeof error === 'object' && error) {
    try {
      return JSON.stringify(error);
    } catch {
      // fall through
    }
  }

  return String(error);
}

function isMailgunApiError(error: unknown): error is MailgunApiError {
  return typeof error === 'object' && error !== null && 'status' in error && 'message' in error;
}
