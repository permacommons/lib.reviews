import { promises as fs } from 'node:fs';
import path from 'node:path';

import config from 'config';
import formData from 'form-data';
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
    debug.util('Password reset email not sent - Mailgun API key missing');
    return null;
  }

  mailgunClient = mailgunFactory.client({
    username: 'api',
    key: apiKey,
    url,
  });

  return mailgunClient;
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
  if (!config.get<boolean>('email.enabled')) {
    debug.util('Password reset email not sent - email feature disabled in config');
    return;
  }

  const client = getMailgunClient();
  if (!client) {
    debug.error('Password reset email not sent - Mailgun client unavailable');
    return;
  }

  const qualifiedURL = config.get('qualifiedURL') as string;
  const resetURL = new URL(`reset-password/${resetToken}`, qualifiedURL).toString();
  const expirationHours = config.get<number>('passwordReset.tokenExpirationHours') ?? 3;

  const { subject, text, html } = await loadEmailTemplate('password-reset', language, {
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

async function loadEmailTemplate(
  templateName: string,
  language: string,
  vars: Record<string, string | number>
): Promise<{ subject: string; text: string; html: string }> {
  const supportedLanguages = ['en', 'de'];
  const lang = supportedLanguages.includes(language) ? language : 'en';
  const textTemplate = await readTemplate(`${templateName}-${lang}.txt`);
  const htmlTemplate = await readTemplate(`${templateName}-${lang}.hbs`);

  const subject = textTemplate.split('\n')[0]?.replace('Subject: ', '') ?? '';
  const compiledText = substituteTemplate(textTemplate, vars);
  const compiledHtml = substituteTemplate(htmlTemplate, vars);

  return { subject, text: compiledText, html: compiledHtml };
}

function substituteTemplate(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
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
