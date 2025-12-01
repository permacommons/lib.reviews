# Password Reset Feature Implementation Plan

## Overview

This plan outlines the implementation of a secure password reset feature for lib.reviews using the Mailgun API. The feature will allow users with email addresses to request password resets via email with time-limited, single-use tokens.

## Security & UX Principles

1. **Information Disclosure Prevention**: Do not reveal whether an email exists in the system
2. **Rate Limiting**: Prevent abuse by limiting reset requests (3-hour cooldown per email)
3. **Token Security**: 3-hour expiration, single-use, cryptographically secure tokens
4. **User-Friendly**: Progressive enhancement with password reveal feature across all password forms

## Phase 0: Preparatory Work

### 0.1 Password Reveal Feature (Frontend)

**Goal**: Add a "Reveal password" toggle to all password input fields that works with progressive enhancement.

**Implementation Details**:

- **Files to modify**:
  - `frontend/libreviews.ts` - Add password reveal utility function
  - `views/register.hbs` - Add reveal control to password field
  - `views/signin.hbs` - Add reveal control to password field
  - `locales/en.json` - Add i18n messages

- **Technical approach**:
  - Create `setupPasswordReveal()` function in `frontend/libreviews.ts`
  - Add to the global exports (line 703) alongside `trimInput`
  - Pattern: Create a wrapper div around password inputs with class `password-input-wrapper`
  - Add a button with class `password-reveal-toggle` that toggles the input type between "password" and "text"
  - Use CSS to hide the button when JavaScript is disabled (`.password-reveal-toggle { display: none; }` by default, shown via JS)
  - Apply icon/text toggle: "Show" vs "Hide" or use eye icon if available

- **i18n keys to add**:
  - `"show password": "Show password"`
  - `"hide password": "Hide password"`

- **CSS considerations**:
  - Position toggle button inside or adjacent to password field
  - Ensure accessible contrast and click target size
  - Mobile-friendly touch targets

**Files affected**:
- `frontend/libreviews.ts` (new function ~10 lines)
- `views/register.hbs` (modify password field wrapper)
- `views/signin.hbs` (modify password field wrapper)
- `locales/en.json` (2 new keys)
- `frontend/styles/style.less` (styling for password reveal toggle)

### 0.2 Database Schema Migrations

**Goal**: Create necessary database tables and indexes for password reset functionality.

**Migration file**: `migrations/002_password_reset.sql`

**Tables to create**:

```sql
-- Password reset tokens table
CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email VARCHAR(128) NOT NULL,  -- Store email at time of request
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,  -- NULL = unused
  ip_address INET,  -- Optional: track requesting IP for audit

  CONSTRAINT password_reset_tokens_user_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for token lookup (primary use case)
CREATE INDEX idx_password_reset_tokens_id_expires
  ON password_reset_tokens(id, expires_at)
  WHERE used_at IS NULL;

-- Index for rate limiting check (find recent requests by email)
CREATE INDEX idx_password_reset_tokens_email_created
  ON password_reset_tokens(email, created_at DESC);
```

**Design decisions**:
- `id` is the token itself (UUID v4, cryptographically random via `gen_random_uuid()`)
- Store `email` at time of request (handles case where user changes email)
- `expires_at` pre-calculated for efficient queries
- `used_at` implements single-use tokens (NULL check)
- Partial index on unused, non-expired tokens for performance
- Cascade delete when user is deleted (cleanup)

**Migration testing**:
- Verify migration runs cleanly
- Test index performance with sample data
- Verify foreign key constraints work correctly

**Migration rollback** (down migration):
```sql
-- Rollback: Drop password reset infrastructure
DROP INDEX IF EXISTS idx_password_reset_tokens_email_created;
DROP INDEX IF EXISTS idx_password_reset_tokens_id_expires;
DROP TABLE IF EXISTS password_reset_tokens;
```

### 0.3 Password Reset Token Model

**Goal**: Create model layer for password reset tokens following lib.reviews patterns.

**Files to create**:

1. **`models/manifests/password-reset-token.ts`** - Schema definition
   - Follow pattern from `models/manifests/user.ts` and `models/manifests/invite-link.ts`
   - Define fields: id, userID, email, createdAt, expiresAt, usedAt, ipAddress
   - Mark `userID` as foreign key to users table
   - Define sensitive fields (email, ipAddress)

2. **`models/password-reset-token.ts`** - Model implementation
   - Follow pattern from `models/invite-link.ts` (similar token-based use case)
   - Static methods:
     - `create(userID, email, ipAddress?)` - Creates new token using configured expiration hours
     - `findByID(tokenID)` - Find token by ID with expiration/usage check
     - `markAsUsed(tokenID)` - Mark token as used (set `usedAt`)
     - `invalidateAllForUser(userID)` - Mark all unused tokens for a user as used
     - `hasRecentRequest(email, cooldownHours)` - Check if email has request within configured cooldown window
   - Instance methods:
     - `isValid()` - Check if token is not expired and not used
     - `getUser()` - Fetch associated user

**Technical patterns to follow**:
- Use `DataModel` base class from DAL
- Import manifest and use type inference
- Follow error handling patterns from existing models
- Use async/await consistently
- Leverage PostgreSQL's `gen_random_uuid()` for token generation

**Sample code structure**:
```typescript
// models/password-reset-token.ts
import config from 'config';
import { DataModel } from '../dal/lib/model-types.ts';
import manifest from './manifests/password-reset-token.ts';

export class PasswordResetToken extends DataModel {
  static manifest = manifest;

  static async create(userID: string, email: string, ipAddress?: string) {
    const expirationHours = config.get<number>('passwordReset.tokenExpirationHours') ?? 3;
    const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000);
    return await this.insert({
      userID,
      email,
      expiresAt,
      ipAddress
    });
  }

  static async hasRecentRequest(email: string, cooldownHours: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const recent = await this.query()
      .where('email', '=', email)
      .where('created_at', '>', cutoff)
      .first();
    return !!recent;
  }

  static async invalidateAllForUser(userID: string): Promise<void> {
    const now = new Date();
    await this.query()
      .where('user_id', '=', userID)
      .whereNull('used_at')
      .update({ used_at: now });
  }

  isValid(): boolean {
    return !this.usedAt && this.expiresAt > new Date();
  }
}
```

### 0.4 Email Infrastructure Setup

**Goal**: Integrate Mailgun API for sending password reset emails.

**Dependencies to add**:
- Install `mailgun.js` package: `npm install mailgun.js form-data`
- Types: `npm install --save-dev @types/mailgun.js`

**Configuration** (`config/default.json5`):
```json5
// Email infrastructure - disabled by default, enable when configured
email: {
  enabled: false,  // Master switch for all email features
  provider: "mailgun",  // Currently only mailgun supported
  mailgun: {
    apiKey: "your-api-key-here",
    domain: "mg.lib.reviews",  // or your Mailgun domain
    from: "lib.reviews <noreply@lib.reviews>",
    // Optional: EU region
    url: "https://api.mailgun.net"  // or https://api.eu.mailgun.net
  }
},

// Password reset feature configuration
passwordReset: {
  tokenExpirationHours: 3,  // How long reset tokens remain valid
  rateLimitPerIP: 10,  // Max requests per IP per hour
  cooldownHours: 3  // Minimum time between reset requests for same email
}
```

**Email utility module**: `util/email.ts`

Create a reusable email sending utility:
```typescript
import config from 'config';
import formData from 'form-data';
import Mailgun from 'mailgun.js';

const mailgun = new Mailgun(formData);
let mg: ReturnType<typeof mailgun.client> | null = null;

// Initialize Mailgun client only if email is enabled
if (config.get('email.enabled')) {
  mg = mailgun.client({
    username: 'api',
    key: config.get('email.mailgun.apiKey'),
    url: config.get('email.mailgun.url')
  });
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  language: string = 'en'
): Promise<void> {
  // Check if email is enabled
  if (!config.get('email.enabled')) {
    debug.warn('Password reset email not sent - email feature disabled in config');
    return;
  }

  if (!mg) {
    throw new Error('Mailgun client not initialized');
  }

  const resetURL = `${config.get('qualifiedURL')}reset-password/${resetToken}`;
  const expirationHours = config.get('passwordReset.tokenExpirationHours');

  // Load localized email templates
  const { subject, text, html } = await loadEmailTemplate(
    'password-reset',
    language,
    { resetURL, expirationHours }
  );

  await mg.messages.create(config.get('email.mailgun.domain'), {
    from: config.get('email.mailgun.from'),
    to: [to],
    subject,
    text,
    html
  });
}

/**
 * Load email template in the specified language with variable substitution.
 */
async function loadEmailTemplate(
  templateName: string,
  language: string,
  vars: Record<string, any>
): Promise<{ subject: string; text: string; html: string }> {
  // Fallback to English if language not supported
  const supportedLanguages = ['en', 'de'];
  const lang = supportedLanguages.includes(language) ? language : 'en';

  // Load templates from views/email/
  const textTemplate = await fs.readFile(
    `views/email/${templateName}-${lang}.txt`,
    'utf-8'
  );
  const htmlTemplate = await fs.readFile(
    `views/email/${templateName}-${lang}.hbs`,
    'utf-8'
  );

  // Simple variable substitution (or use Handlebars for HTML)
  const subject = textTemplate.split('\n')[0].replace('Subject: ', '');
  const text = textTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
  const html = htmlTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');

  return { subject, text, html };
}

export async function testEmailConfiguration(): Promise<boolean> {
  try {
    await mg.domains.list();
    return true;
  } catch (error) {
    console.error('Mailgun configuration error:', error);
    return false;
  }
}
```

**Error handling**:
- Gracefully handle Mailgun API errors (log but don't expose to user)
- Consider retry logic for transient failures
- Add debug logging for email sending
- If `email.enabled` is false, fail silently and log warning (don't expose to user)

**Behavior when email is disabled**:
- The forgot-password form will still be accessible
- Users can submit their email address
- The same success message is shown (maintains security, no enumeration)
- However, no email is actually sent (logged as warning)
- This allows the feature to be present in the UI but non-functional until email is configured

**Testing considerations**:
- Use Mailgun sandbox domain for development
- Test behavior with `email.enabled: false` to ensure graceful degradation
- Consider email template testing

## Phase 1: Request Password Reset Flow

### 1.1 Forgot Password Form

**Goal**: Create a simple form where users can enter their email to request a password reset.

**Route**: `GET /forgot-password`

**Files to create**:
- `views/forgot-password.hbs`

**Template structure**:
```handlebars
<h1>{{{__ "forgot password"}}}</h1>
<p>{{{__ "forgot password instructions"}}}</p>

{{> page_errors}}

<form class="pure-form pure-form-aligned" action="/forgot-password" method="post">
  <input type="hidden" name="_csrf" value="{{csrfToken}}">
  <fieldset>
    <div class="pure-control-group">
      <label for="email">{{{__ "email"}}} <span class="required">*</span></label>
      <input
        id="email"
        name="email"
        type="email"
        data-auto-trim
        data-required
        data-focus
        placeholder="{{{__ "enter email"}}}"
        class="pure-input-1 login-form-input">
    </div>

    <div class="validation-error" id="required-fields-message">
      {{{__ "complete all required fields"}}}
    </div>

    <button type="submit" data-check-required class="pure-button pure-button-primary button-rounded">
      {{{__ "send reset link"}}}
    </button>

    <p>{{{__ "remember password" }}}</p>
  </fieldset>
</form>
```

**i18n messages** (`locales/en.json`):
```json
"forgot password": "Forgot password",
"forgot password instructions": "Enter your email address below. If an account with this email address exists, a password reset email will be sent shortly, unless one has already been sent within the last 3 hours. If you do not see the email, please check your spam folder, or feel free to contact us at lib.reviews@permacommons.org.",
"send reset link": "Send reset link",
"remember password": "Remember your password? <a href='/signin'>Sign in</a> instead.",
"reset email sent": "If an account with this email address exists, a password reset email will be sent shortly. Please check your email (including spam folder).",
```

**Files to modify**:
- `routes/actions.ts` - Add GET route handler
- `locales/en.json` - Add message keys

### 1.2 Process Password Reset Request

**Goal**: Handle the form submission, create token, send email (if email exists).

**Route**: `POST /forgot-password`

**Implementation** (`routes/actions.ts`):

```typescript
// Zod schema for validation
const forgotPasswordSchema = z.object({
  _csrf: z.string().min(1),
  email: z.string().email().max(128)
}).strict();

// POST handler
router.post('/forgot-password', async (req, res) => {
  try {
    const formData = forgotPasswordSchema.parse(req.body);
    const email = formData.email.toLowerCase().trim();

    // ALWAYS show the same success message (prevent email enumeration)
    const successMessage = req.__('reset email sent');

    // Check rate limiting first (3-hour window per email)
    const cooldownHours = config.get('passwordReset.cooldownHours');
    const hasRecent = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
    if (hasRecent) {
      // Still show success message, but don't send another email
      req.flash('success', successMessage);
      return res.redirect('/forgot-password');
    }

    // Find ALL users with this email (handles duplicate emails)
    const users = await User.query()
      .where('email', '=', email)
      .whereNotNull('password')  // Skip locked accounts
      .all();

    if (users.length > 0) {
      // Create reset token for EACH user with this email
      for (const user of users) {
        const token = await PasswordResetToken.create(
          user.id,
          email,
          req.ip
        );

        // Send email (don't await - fail silently)
        sendPasswordResetEmail(email, token.id, req.language)
          .catch(err => {
            debug.error('Failed to send password reset email:', err);
          });
      }
    }

    // ALWAYS show success (even if email not found)
    req.flash('success', successMessage);
    res.redirect('/forgot-password');

  } catch (error) {
    if (error instanceof z.ZodError) {
      req.flash('error', req.__('invalid email format'));
      return res.redirect('/forgot-password');
    }
    throw error;
  }
});
```

**Security considerations**:
- ALWAYS return same message regardless of whether email exists or how many users have it
- Send reset token for ALL users with that email (handles duplicate email case)
- Rate limit by email (configurable cooldown, default 3 hours) to prevent spam
- Don't send reset to locked accounts (NULL password)
- Log failed email sends but don't inform user
- Capture IP address for audit trail

**Files to modify**:
- `routes/actions.ts` - Add POST route handler

**Required imports to add to `routes/actions.ts`**:
```typescript
import isUUID from 'is-uuid';  // For UUID validation
import { PasswordResetToken } from '../models/password-reset-token.ts';
import { sendPasswordResetEmail } from '../util/email.ts';
```

### 1.3 Navigation & Discovery

**Goal**: Make the password reset feature discoverable from login page.

**Files to modify**:
- `views/signin.hbs` - Add "Forgot password?" link below sign-in button

**Template change**:
```handlebars
<button ... >{{{__ "sign in"}}}</button>
<p><a href="/forgot-password">{{{__ "forgot your password"}}}</a></p>
<p>{{{__ "no account yet" }}}</p>
```

**i18n**:
```json
"forgot your password": "Forgot your password?"
```

## Phase 2: Reset Password Flow

### 2.1 Reset Password Form

**Goal**: Display form where users can enter new password using their reset token.

**Route**: `GET /reset-password/:token`

**Files to create**:
- `views/reset-password.hbs`

**Template structure**:
```handlebars
<h1>{{{__ "reset password"}}}</h1>

{{#if tokenValid}}
  <p>{{{__ "enter new password"}}}</p>
  {{> page_errors}}

  <form class="pure-form pure-form-aligned" action="/reset-password/{{token}}" method="post">
    <input type="hidden" name="_csrf" value="{{csrfToken}}">
    <fieldset>
      <div class="pure-control-group">
        <label for="password">{{{__ "new password"}}} <span class="required">*</span></label>
        <div class="password-input-wrapper">
          <input
            id="password"
            name="password"
            type="password"
            data-required
            data-focus
            minlength="6"
            placeholder="{{{__ "enter password"}}}"
            class="pure-input-1 login-form-input">
          <!-- Password reveal toggle added by JS -->
        </div>
      </div>

      <div class="validation-error" id="required-fields-message">
        {{{__ "complete all required fields"}}}
      </div>

      <button type="submit" data-check-required class="pure-button pure-button-primary button-rounded">
        {{{__ "reset password"}}}
      </button>
    </fieldset>
  </form>
{{else}}
  <div class="error-box">
    {{{__ "invalid reset token"}}}
  </div>
  <p><a href="/forgot-password">{{{__ "request new reset link"}}}</a></p>
{{/if}}
```

**Route handler** (`routes/actions.ts`):
```typescript
router.get('/reset-password/:token', async (req, res) => {
  const tokenID = req.params.token;

  // Validate UUID format (using is-uuid package, same as rest of codebase)
  if (!isUUID.v4(tokenID)) {
    return render.template(req, res, 'reset-password', {
      tokenValid: false
    });
  }

  // Check if token exists and is valid
  const token = await PasswordResetToken.findByID(tokenID);
  const tokenValid = token && token.isValid();

  render.template(req, res, 'reset-password', {
    token: tokenID,
    tokenValid
  });
});
```

**i18n messages**:
```json
"reset password": "Reset password",
"new password": "New password",
"enter new password": "Enter your new password below. Passwords must be at least 6 characters.",
"invalid reset token": "This password reset link is invalid or has expired. Reset links are valid for 3 hours and can only be used once.",
"request new reset link": "Request a new password reset link",
```

**Files to modify**:
- `routes/actions.ts` - Add GET route handler
- `locales/en.json` - Add message keys

### 2.2 Process Password Reset

**Goal**: Validate token, update password, mark token as used, sign user in.

**Route**: `POST /reset-password/:token`

**Implementation** (`routes/actions.ts`):

```typescript
const resetPasswordSchema = z.object({
  _csrf: z.string().min(1),
  password: z.string().min(6)
}).strict();

router.post('/reset-password/:token', async (req, res) => {
  const tokenID = req.params.token;

  try {
    const formData = resetPasswordSchema.parse(req.body);

    // Validate UUID format (using is-uuid package, same as rest of codebase)
    if (!isUUID.v4(tokenID)) {
      req.flash('error', req.__('invalid reset token'));
      return res.redirect(`/reset-password/${tokenID}`);
    }

    // Find and validate token
    const token = await PasswordResetToken.findByID(tokenID);
    if (!token || !token.isValid()) {
      req.flash('error', req.__('invalid reset token'));
      return res.redirect(`/reset-password/${tokenID}`);
    }

    // Get user
    const user = await User.findByID(token.userID);
    if (!user) {
      debug.error(`Reset token ${tokenID} references non-existent user ${token.userID}`);
      req.flash('error', req.__('invalid reset token'));
      return res.redirect(`/reset-password/${tokenID}`);
    }

    // Update password
    await user.setPassword(formData.password);
    await user.save();

    // Mark THIS token as used
    await token.markAsUsed();

    // Invalidate ALL other unused tokens for this user (security measure)
    await PasswordResetToken.invalidateAllForUser(user.id);

    // Log the user in
    req.login(user, (err) => {
      if (err) {
        debug.error('Failed to log in user after password reset:', err);
        req.flash('error', req.__('unknown error'));
        return res.redirect('/signin');
      }

      req.flash('success', req.__('password reset success'));
      res.redirect('/');
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      if (error.errors.some(e => e.path.includes('password'))) {
        req.flash('error', req.__('password too short', 6));
      } else {
        req.flash('error', req.__('correct errors'));
      }
      return res.redirect(`/reset-password/${tokenID}`);
    }
    throw error;
  }
});
```

**Security considerations**:
- Verify token is not expired and not already used
- Atomic operation: update password + mark token as used + invalidate all other tokens
- **Invalidate all unused tokens for the user** - prevents use of old reset links after password change
- Automatically log user in after successful reset (good UX)
- Handle edge cases (deleted user, etc.)

**i18n messages**:
```json
"password reset success": "Your password has been reset successfully. You are now logged in.",
```

**Files to modify**:
- `routes/actions.ts` - Add POST route handler
- `locales/en.json` - Add message keys

## Phase 3: Polish & Testing

### 3.1 Email Templates

**Goal**: Create professional, localized email templates.

**Implementation**:
- Create `views/email/` directory for email templates
- Use Handlebars for HTML templates (consistent with rest of app)
- Create both HTML and plain text versions
- Support English and German as proof-of-concept (easily extensible to more languages)

**Files to create**:
- `views/email/password-reset-en.txt` (Plain text, English)
- `views/email/password-reset-en.hbs` (HTML, English)
- `views/email/password-reset-de.txt` (Plain text, German)
- `views/email/password-reset-de.hbs` (HTML, German)

**Template variables**:
- `{{resetURL}}` - The full reset link
- `{{expirationHours}}` - Number of hours until token expires

**English template example** (`password-reset-en.txt`):
```
Subject: Password Reset Request - lib.reviews

Hello,

You (or someone else) requested a password reset for your lib.reviews account.

To reset your password, visit this link within the next {{expirationHours}} hours:
{{resetURL}}

If you did not request this reset, you can safely ignore this email. Your password will not be changed.

If you need assistance, please contact us at lib.reviews@permacommons.org.

Best regards,
The lib.reviews team
```

**German template example** (`password-reset-de.txt`):
```
Subject: Neues Passwort setzen - lib.reviews

Hallo,

Sie (oder jemand anderes) haben angefordert, das Passwort für Ihr lib.reviews-Konto zurückzusetzen.

Um ein neues Passwort zu setzen, besuchen Sie diesen Link innerhalb der nächsten {{expirationHours}} Stunden:
{{resetURL}}

Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren. Ihr Passwort wird nicht geändert.

Bei Fragen kontaktieren Sie uns bitte unter lib.reviews@permacommons.org.

Mit freundlichen Grüßen,
Das lib.reviews-Team
```

**Modify**: `util/email.ts` already updated to load templates dynamically

### 3.2 Rate Limiting & Abuse Prevention

**Goal**: Add additional protections against abuse.

**Enhancements**:
1. **IP-based rate limiting**: Limit requests per IP address
   - Use `express-rate-limit` package
   - Configuration: 10 requests per IP per hour (high enough for normal use, prevents spam)
   - Add as middleware to `/forgot-password` POST route

2. **Token cleanup**: Add maintenance task to delete expired tokens
   - Create script: `maintenance/cleanup-reset-tokens.ts`
   - Delete tokens older than 7 days
   - Run daily via cron job
   - Example cron: `0 2 * * * cd /path/to/lib.reviews && node maintenance/cleanup-reset-tokens.js >> /var/log/cleanup-tokens.log 2>&1`

**Implementation**:

Add to `package.json`:
```json
"express-rate-limit": "^7.1.0"
```

Add to `routes/actions.ts`:
```typescript
import rateLimit from 'express-rate-limit';

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.get('passwordReset.rateLimitPerIP'), // 10 requests per IP
  message: 'Too many password reset requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply to POST route
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  // ... existing handler
});
```

**Files to modify**:
- `routes/actions.ts` - Add rate limiting middleware
- `package.json` - Add express-rate-limit dependency
- Create `maintenance/cleanup-reset-tokens.ts`

### 3.3 Frontend Integration

**Goal**: Ensure password reveal feature works correctly on new reset password page.

**Files to modify**:
- `frontend/libreviews.ts` - Ensure `setupPasswordReveal()` is called on page load
- `views/reset-password.hbs` - Ensure password field has proper wrapper structure

**Testing**:
- Verify password reveal works with keyboard (accessibility)
- Test with JavaScript disabled (should degrade gracefully)
- Test on mobile devices (touch targets)

### 3.4 Admin Tools

**Goal**: Provide admin tools for managing password resets.

**Features**:
1. View recent reset requests (for debugging/audit)
2. Manually expire/invalidate tokens if needed
3. Stats on reset request volume

**Implementation**:
- Add admin routes in `routes/handlers/admin-handlers.ts` (or create if doesn't exist)
- Require `is_super_user` permission
- Create admin view template

**Future work**: This can be deprioritized for MVP.

### 3.5 Testing Plan

**Unit tests**:
- `PasswordResetToken.create()` - Creates valid tokens
- `PasswordResetToken.hasRecentRequest()` - Rate limiting logic
- `PasswordResetToken.isValid()` - Expiration and usage checks
- `sendPasswordResetEmail()` - Email sending (mock Mailgun)

**Integration tests**:
- Full flow: Request reset → receive email → reset password → login
- Edge cases:
  - Expired token
  - Already-used token
  - Invalid token format
  - Non-existent email
  - Locked account (NULL password)
  - Rate limiting (multiple requests)
  - Email sending failure

**Manual testing**:
- Test with real Mailgun sandbox
- Verify email delivery to various providers (Gmail, Outlook, etc.)
- Check spam folder placement
- Test email client rendering (HTML/text versions)
- Accessibility testing (screen readers, keyboard navigation)

## Files Summary

### New files to create:
1. `migrations/002_password_reset.sql` - Database schema
2. `models/manifests/password-reset-token.ts` - Model schema
3. `models/password-reset-token.ts` - Model implementation
4. `util/email.ts` - Email sending utility
5. `views/forgot-password.hbs` - Request reset form
6. `views/reset-password.hbs` - Reset password form
7. `views/email/password-reset-*.hbs` - Email templates (HTML)
8. `views/email/password-reset-*.txt` - Email templates (plain text)
9. `maintenance/cleanup-reset-tokens.ts` - Token cleanup script

### Files to modify:
1. `routes/actions.ts` - Add 4 new routes (GET/POST for forgot & reset)
2. `views/signin.hbs` - Add "Forgot password?" link
3. `views/register.hbs` - Add password reveal control
4. `views/reset-password.hbs` - Add password reveal control (created above, modified for reveal)
5. `frontend/libreviews.ts` - Add password reveal function
6. `frontend/styles/style.less` - Add password reveal styling
7. `locales/en.json` - Add ~15 new message keys
8. `locales/de.json` - Add German translations for new keys
9. `config/default.json5` - Add email + password reset configuration
10. `package.json` - Add mailgun.js and express-rate-limit dependencies

### Estimated files touched:
- **New**: 9 files
- **Modified**: 10 files
- **Total**: 19 files

## Dependencies

### NPM packages to add:
```json
{
  "dependencies": {
    "mailgun.js": "^10.2.3",
    "form-data": "^4.0.0",
    "express-rate-limit": "^7.1.0"
  },
  "devDependencies": {
    "@types/mailgun.js": "^1.0.0"
  }
}
```

### External services:
- Mailgun account (free tier supports 5,000 emails/month)
- Domain verification for sending emails

## Configuration Required

### Development:
```json5
// config/development.json5
{
  // Enable email features in development
  email: {
    enabled: true,
    provider: "mailgun",
    mailgun: {
      apiKey: "your-sandbox-api-key",
      domain: "sandboxXXX.mailgun.org",
      from: "lib.reviews <noreply@sandboxXXX.mailgun.org>",
      url: "https://api.mailgun.net"
    }
  },

  // Password reset settings
  passwordReset: {
    tokenExpirationHours: 3,
    rateLimitPerIP: 10,
    cooldownHours: 3
  }
}
```

### Production:
```json5
// config/production.json5
{
  // Enable email features in production
  email: {
    enabled: true,
    provider: "mailgun",
    mailgun: {
      apiKey: "your-production-api-key",
      domain: "mg.lib.reviews",
      from: "lib.reviews <noreply@lib.reviews>",
      url: "https://api.mailgun.net"  // or .eu for Europe
    }
  },

  // Password reset settings
  passwordReset: {
    tokenExpirationHours: 3,
    rateLimitPerIP: 10,
    cooldownHours: 3
  }
}
```

## Implementation Order

### Recommended sequence:

1. **Phase 0.1**: Password reveal feature (can be done independently, provides immediate value)
2. **Phase 0.2**: Database migration (prerequisite for everything else)
3. **Phase 0.3**: Password reset token model (prerequisite for routes)
4. **Phase 0.4**: Email infrastructure (prerequisite for sending emails)
5. **Phase 1**: Request password reset flow (user-facing feature)
6. **Phase 2**: Reset password flow (completes the feature)
7. **Phase 3**: Polish, testing, and hardening

### Estimated effort:
- Phase 0: 4-6 hours
- Phase 1: 2-3 hours
- Phase 2: 2-3 hours
- Phase 3: 4-6 hours
- **Total**: 12-18 hours

## Security Checklist

- [ ] Tokens are cryptographically random (UUID v4)
- [ ] Tokens expire after 3 hours (configurable)
- [ ] Tokens are single-use (marked as used)
- [ ] **All unused tokens invalidated on successful password reset**
- [ ] No email enumeration (same message for all requests)
- [ ] Rate limiting (3-hour cooldown per email, configurable)
- [ ] IP-based rate limiting (10 per hour, configurable)
- [ ] CSRF protection on all forms
- [ ] Password minimum length enforced (6 characters)
- [ ] Locked accounts cannot reset (NULL password check)
- [ ] Email sending failures are logged but not exposed
- [ ] Reset links use HTTPS (qualifiedURL config)
- [ ] Audit trail (IP address, timestamps)
- [ ] Database indexes for performance
- [ ] SQL injection protection (parameterized queries via DAL)
- [ ] Email infrastructure can be disabled via config (disabled by default)

## Known Issues & Future Enhancements

### Known limitations:
1. **Email uniqueness**: Multiple users can share the same email address
   - Current plan: Send reset to ALL users with that email
   - Alternative: Only allow one user per email (requires migration)

2. **Language detection**: Email language based on request language
   - Future: Store user's preferred language in database

3. **No email verification**: Users can enter any email without verification
   - Future: Add email verification flow for new accounts

### Future enhancements:
1. Email change flow (similar to password reset)
2. Two-factor authentication
3. Account recovery questions
4. "Remember this device" functionality
5. Password strength meter on forms
6. Breach detection (HaveIBeenPwned integration)
7. Email template customization per team/instance

## Decisions Made

1. **Email uniqueness**: ✅ No UNIQUE constraint. Send password reset to ALL users with that email address (currently one duplicate exists, will be handled manually). No constraint check to avoid enumeration vector.

2. **Rate limiting strictness**: ✅ IP-based rate limiting at 10 requests per IP per hour (high enough to not interfere with normal users, low enough to prevent spam). No per-email rate limiting beyond the 3-hour cooldown.

3. **Token expiration**: ✅ 3 hours, but make it configurable via site config (`passwordReset.tokenExpirationHours`).

4. **Auto-login after reset**: ✅ Yes, automatically log users in after successful password reset (better UX).

5. **Email templates**: ✅ Localized from the beginning. Create English + German templates as proof-of-concept.

6. **CAPTCHA**: ✅ Not required on forgot-password form.

7. **Email infrastructure decoupled**: ✅ Email configuration (`email.enabled`) is separate from password reset settings. Email is a shared infrastructure for all email features (future: notifications, etc.). Password reset settings control token expiration and rate limiting only.

8. **UUID validation**: ✅ Use existing `is-uuid` package with `isUUID.v4(tokenID)` pattern, consistent with rest of codebase.

9. **Migration rollback**: ✅ Include down migration with DROP TABLE statements for clean rollback.

10. **Token cleanup**: ✅ Daily cron job to delete tokens older than 7 days via `maintenance/cleanup-reset-tokens.ts`.

## Appendix: Code Patterns Reference

### Pattern: DAL Model (from invite-link.ts)
```typescript
import { DataModel } from '../dal/lib/model-types.ts';
import manifest from './manifests/invite-link.ts';

export class InviteLink extends DataModel {
  static manifest = manifest;

  static async create(createdBy: string) {
    return await this.insert({ createdBy });
  }
}
```

### Pattern: Route Handler (from actions.ts)
```typescript
const schema = z.object({
  _csrf: z.string().min(1),
  field: z.string()
}).strict();

router.post('/route', async (req, res) => {
  try {
    const formData = schema.parse(req.body);
    // ... handle
    req.flash('success', req.__('message key'));
    res.redirect('/somewhere');
  } catch (error) {
    if (error instanceof z.ZodError) {
      req.flash('error', req.__('validation error'));
      return res.redirect('/route');
    }
    throw error;
  }
});
```

### Pattern: Template (from signin.hbs)
```handlebars
{{> page_errors}}
<form class="pure-form pure-form-aligned" action="/endpoint" method="post">
  <input type="hidden" name="_csrf" value="{{csrfToken}}">
  <fieldset>
    <div class="pure-control-group">
      <label for="field">{{{__ "label"}}} <span class="required">*</span></label>
      <input
        id="field"
        name="field"
        type="text"
        data-required
        data-auto-trim
        data-focus
        placeholder="{{{__ "placeholder"}}}"
        class="pure-input-1 login-form-input">
    </div>
    <button type="submit" data-check-required class="pure-button pure-button-primary button-rounded">
      {{{__ "button"}}}
    </button>
  </fieldset>
</form>
```

---

**Plan Version**: 1.0
**Last Updated**: 2025-11-29
**Status**: Ready for review
