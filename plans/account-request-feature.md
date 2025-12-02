# Account Request Feature Implementation Plan

## Overview

This feature allows site visitors to request user accounts when the site is in invite-only mode. Moderators receive email notifications about new requests and can approve/reject them through a dedicated management interface.

## Feature Workflow

1. **Visitor submits request** → Form at `/actions/request-account`
2. **Email sent to moderators** → All moderators with email addresses notified
3. **Moderator reviews requests** → Management queue at `/actions/manage-requests`
4. **Moderator takes action** → Approve (sends invite code) or Reject (optionally sends rejection email)
5. **Request lifecycle** → Approved/rejected requests archived for 90 days, then cleaned up

## Implementation Phases

### Phase 1: Database Foundation

**File: `migrations/003_account_requests.sql`**

Create the `account_requests` table with the following structure:

```sql
CREATE TABLE account_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Request data
  planned_reviews TEXT NOT NULL,
  languages TEXT NOT NULL,
  about_url TEXT NOT NULL,
  email VARCHAR(128) NOT NULL,
  terms_accepted BOOLEAN NOT NULL DEFAULT true,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ip_address INET,

  -- Status tracking
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Moderation data
  moderated_by UUID,
  moderated_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,

  -- Invite link (when approved)
  invite_link_id UUID,

  -- Foreign keys
  CONSTRAINT account_requests_moderated_by_fkey
    FOREIGN KEY (moderated_by) REFERENCES users(id),
  CONSTRAINT account_requests_invite_link_fkey
    FOREIGN KEY (invite_link_id) REFERENCES invite_links(id)
);

-- Index for moderator queue (pending requests first, sorted by date)
CREATE INDEX idx_account_requests_status_created
  ON account_requests(status, created_at DESC);

-- Index for moderator lookup
CREATE INDEX idx_account_requests_moderated_by
  ON account_requests(moderated_by)
  WHERE moderated_by IS NOT NULL;

-- Index for cleanup job (find old requests)
CREATE INDEX idx_account_requests_created_at
  ON account_requests(created_at)
  WHERE status != 'pending';
```

**File: `migrations/down/003_account_requests.sql`**

```sql
DROP INDEX IF EXISTS idx_account_requests_created_at;
DROP INDEX IF EXISTS idx_account_requests_moderated_by;
DROP INDEX IF EXISTS idx_account_requests_status_created;
DROP TABLE IF EXISTS account_requests;
```

**Run migration:**
- Migrations run automatically via `initializeDAL()` in bootstrap
- See test 39 for an example of testing migration and rollback.

### Phase 2: Model Layer

**File: `models/manifests/account-request.ts`**

Define the TypeScript schema and model manifest:

```typescript
import { types } from '@graffy/common';
import { createManifest } from '../helpers/create-manifest.ts';

export type AccountRequestStatus = 'pending' | 'approved' | 'rejected';

const accountRequestManifest = {
  tableName: 'account_requests',
  hasRevisions: false as const,
  schema: {
    id: types
      .string()
      .uuid(4)
      .default(() => randomUUID()),

    // Request form fields
    plannedReviews: types.string().required(true),
    languages: types.string().required(true),
    aboutURL: types.string().required(true),
    email: types.string().required(true),
    termsAccepted: types.boolean().default(true),

    // Metadata
    createdAt: types.date().default(() => new Date()),
    ipAddress: types.string(),

    // Status
    status: types.string().default('pending'),

    // Moderation
    moderatedBy: types.string().uuid(4),
    moderatedAt: types.date(),
    rejectionReason: types.string(),

    // Invite link
    inviteLinkID: types.string().uuid(4),
  },
  relationships: {
    moderator: {
      type: 'one' as const,
      model: 'User',
      foreignKey: 'moderatedBy',
    },
    inviteLink: {
      type: 'one' as const,
      model: 'InviteLink',
      foreignKey: 'inviteLinkID',
    },
  },
};

export default createManifest(accountRequestManifest);
export type AccountRequestManifest = typeof accountRequestManifest;
```

**File: `models/account-request.ts`**

Create the model with business logic methods:

```typescript
import { Model } from '@graffy/common';
import accountRequestManifest, {
  type AccountRequestManifest,
  type AccountRequestStatus,
} from './manifests/account-request.ts';
import type { AccountRequestInstance } from '../types/models.d.ts';

class AccountRequestModel extends Model<AccountRequestManifest> {
  /**
   * Get all pending account requests, sorted by creation date (oldest first)
   */
  static async getPending(): Promise<AccountRequestInstance[]> {
    return this.filterWhere({
      status: 'pending',
    })
      .orderBy('createdAt', 'ASC')
      .run();
  }

  /**
   * Get all moderated (approved/rejected) requests with moderator info
   * Sorted by moderation date (newest first) for the moderator log
   */
  static async getModerated(limit = 100): Promise<AccountRequestInstance[]> {
    return this.filterWhere({
      status: this.ops.neq('pending'),
    })
      .orderBy('moderatedAt', 'DESC')
      .limit(limit)
      .run();
  }

  /**
   * Check if an email has a recent pending request (within cooldown period)
   */
  static async hasRecentRequest(
    email: string,
    cooldownHours: number
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    const requests = await this.filterWhere({
      email: email.toLowerCase(),
      status: 'pending',
      createdAt: this.ops.gte(cutoff),
    }).run();
    return requests.length > 0;
  }

  /**
   * Check if an IP has exceeded rate limit
   */
  static async checkIPRateLimit(
    ipAddress: string,
    maxRequests: number,
    windowHours: number
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const requests = await this.filterWhere({
      ipAddress,
      createdAt: this.ops.gte(cutoff),
    }).run();
    return requests.length >= maxRequests;
  }

  /**
   * Create a new account request
   */
  static async createRequest(data: {
    plannedReviews: string;
    languages: string;
    aboutURL: string;
    email: string;
    termsAccepted: boolean;
    ipAddress?: string;
  }): Promise<AccountRequestInstance> {
    const request = new this({
      plannedReviews: data.plannedReviews,
      languages: data.languages,
      aboutURL: data.aboutURL,
      email: data.email.toLowerCase(),
      termsAccepted: data.termsAccepted,
      ipAddress: data.ipAddress,
      status: 'pending',
      createdAt: new Date(),
    });
    await request.save();
    return request;
  }
}

export default new AccountRequestModel(accountRequestManifest);
```

**File: `bootstrap/dal.ts`**

Add the model import to register it (around line 20-30, with other model imports):

```typescript
import '../models/account-request.ts';
```

### Phase 3: Email Notifications

**File: `util/email.ts`**

Add function to send moderator notifications (add after `sendPasswordResetEmail`):

```typescript
/**
 * Send account request notification to all moderators
 */
export async function sendAccountRequestNotification(
  requestID: string,
  language: string = 'en'
): Promise<void> {
  if (!config.get<boolean>('email.enabled')) {
    debug.util('Account request notification not sent - email disabled');
    return;
  }

  const client = getMailgunClient();
  if (!client) {
    debug.error('Account request notification not sent - Mailgun unavailable');
    return;
  }

  // Get all moderators with email addresses
  const User = (await import('../models/user.ts')).default;
  const moderators = await User.filterWhere({
    isSiteModerator: true,
  }).run();

  const moderatorsWithEmail = moderators.filter(m => m.email);

  if (moderatorsWithEmail.length === 0) {
    debug.util('No moderators with email addresses found');
    return;
  }

  const qualifiedURL = config.get('qualifiedURL') as string;
  const manageURL = `${qualifiedURL}actions/manage-requests`;

  try {
    const { subject, text, html } = await loadEmailTemplate(
      'account-request-notification',
      language,
      { manageURL }
    );

    for (const moderator of moderatorsWithEmail) {
      try {
        await client.messages.create(config.get('email.mailgun.domain') as string, {
          from: config.get('email.mailgun.from') as string,
          to: [moderator.email],
          subject,
          text,
          html,
        });
      } catch (error) {
        debug.error(
          `Failed to send to ${moderator.email}: ${formatMailgunError(error)}`
        );
      }
    }
  } catch (error) {
    debug.error(`Failed to send notifications: ${formatMailgunError(error)}`);
  }
}

/**
 * Send invite code to approved account requester
 */
export async function sendAccountRequestApproval(
  to: string,
  inviteCode: string,
  language: string = 'en'
): Promise<void> {
  if (!config.get<boolean>('email.enabled')) {
    debug.util('Account approval email not sent - email disabled');
    return;
  }

  const client = getMailgunClient();
  if (!client) {
    debug.error('Account approval email not sent - Mailgun unavailable');
    return;
  }

  const qualifiedURL = config.get('qualifiedURL') as string;
  const registerURL = `${qualifiedURL}register/${inviteCode}`;

  try {
    const { subject, text, html } = await loadEmailTemplate(
      'account-request-approval',
      language,
      { registerURL }
    );

    await client.messages.create(config.get('email.mailgun.domain') as string, {
      from: config.get('email.mailgun.from') as string,
      to: [to],
      subject,
      text,
      html,
    });
  } catch (error) {
    debug.error(`Failed to send approval: ${formatMailgunError(error)}`);
  }
}

/**
 * Send rejection email to account requester (optional)
 */
export async function sendAccountRequestRejection(
  to: string,
  rejectionReason: string,
  language: string = 'en'
): Promise<void> {
  if (!config.get<boolean>('email.enabled')) {
    debug.util('Account rejection email not sent - email disabled');
    return;
  }

  const client = getMailgunClient();
  if (!client) {
    debug.error('Account rejection email not sent - Mailgun unavailable');
    return;
  }

  try {
    const { subject, text, html } = await loadEmailTemplate(
      'account-request-rejection',
      language,
      { rejectionReason }
    );

    await client.messages.create(config.get('email.mailgun.domain') as string, {
      from: config.get('email.mailgun.from') as string,
      to: [to],
      subject,
      text,
      html,
    });
  } catch (error) {
    debug.error(`Failed to send rejection: ${formatMailgunError(error)}`);
  }
}
```

**Email Templates** - Create 6 template files in `views/email/`:

**1. `account-request-notification.txt`** (plain text for moderators):
```
{{__ "account request notification greeting"}}

{{__ "account request notification intro plain"}}

{{__ "account request notification instructions plain"}}
{{manageURL}}

{{__ "account request notification action info plain"}}

{{__ "account request notification signature plain"}}
```

**2. `account-request-notification.hbs`** (HTML for moderators):
```handlebars
<!doctype html>
<html>
  <body>
    <p>{{__ "account request notification greeting"}}</p>
    <p>{{__ "account request notification intro"}}</p>
    <p>
      {{__ "account request notification instructions"}}<br>
      <a href="{{manageURL}}">{{manageURL}}</a>
    </p>
    <p>{{__ "account request notification action info"}}</p>
    <p>
      {{{__ "account request notification signature"}}}
    </p>
  </body>
</html>
```

**3. `account-request-approval.txt`** (plain text for approved requesters):
```
{{__ "account request approval greeting"}}

{{__ "account request approval intro plain"}}

{{__ "account request approval instructions plain"}}
{{registerURL}}

{{__ "account request approval next steps plain"}}

{{__ "account request approval contact plain"}}

{{__ "account request approval signature plain"}}
```

**4. `account-request-approval.hbs`** (HTML for approved requesters):
```handlebars
<!doctype html>
<html>
  <body>
    <p>{{__ "account request approval greeting"}}</p>
    <p>{{__ "account request approval intro"}}</p>
    <p>
      {{__ "account request approval instructions"}}<br>
      <a href="{{registerURL}}">{{registerURL}}</a>
    </p>
    <p>{{__ "account request approval next steps"}}</p>
    <p>
      {{{__ "account request approval contact"}}}
    </p>
    <p>
      {{{__ "account request approval signature"}}}
    </p>
  </body>
</html>
```

**5. `account-request-rejection.txt`** (plain text for rejected requesters):
```
{{__ "account request rejection greeting"}}

{{__ "account request rejection intro plain"}}

{{#if rejectionReason}}
{{__ "account request rejection reason label plain"}} {{rejectionReason}}

{{/if}}
{{__ "account request rejection contact plain"}}

{{__ "account request rejection signature plain"}}
```

**6. `account-request-rejection.hbs`** (HTML for rejected requesters):
```handlebars
<!doctype html>
<html>
  <body>
    <p>{{__ "account request rejection greeting"}}</p>
    <p>{{__ "account request rejection intro"}}</p>
    {{#if rejectionReason}}
    <p>
      <strong>{{__ "account request rejection reason label"}}</strong> {{rejectionReason}}
    </p>
    {{/if}}
    <p>
      {{{__ "account request rejection contact"}}}
    </p>
    <p>
      {{{__ "account request rejection signature"}}}
    </p>
  </body>
</html>
```

### Phase 4: Configuration

**File: `config/default.json5`**

Add rate limiting configuration (add near the `passwordReset` section around line 100):

```json5
accountRequests: {
  // IP-based rate limiting
  rateLimitPerIP: 3,        // Max requests per IP
  rateLimitWindowHours: 24, // Within 24 hours

  // Email cooldown (prevent duplicate requests)
  emailCooldownHours: 24,   // Wait 24h before requesting again with same email

  // Retention
  retentionDays: 90,        // Keep approved/rejected requests for 90 days
}
```

**File: `types/config.d.ts`**

Add TypeScript types (add after `passwordReset` section):

```typescript
accountRequests: {
  rateLimitPerIP: number;
  rateLimitWindowHours: number;
  emailCooldownHours: number;
  retentionDays: number;
};
```

### Phase 5: Request Submission Route

**File: `routes/actions.ts`**

Add the account request form route (add around line 650, after password reset routes):

**1. Import the model and email function:**
```typescript
import AccountRequest from '../models/account-request.ts';
import {
  sendAccountRequestNotification,
  sendAccountRequestApproval,
  sendAccountRequestRejection,
} from '../util/email.ts';
```

**2. Define the Zod schema:**
```typescript
const accountRequestSchema = (req: ActionsRequest) =>
  z.object({
    _csrf: z.string().min(1, req.__('need _csrf')),
    plannedReviews: z.string().min(1, req.__('account request need planned reviews')),
    languages: z.string().min(1, req.__('account request need languages')),
    aboutURL: z.string().min(1, req.__('account request need about url')),
    email: z
      .string()
      .min(1, req.__('need email'))
      .email(req.__('invalid email format')),
    termsAccepted: z
      .string()
      .refine(val => val === 'on', req.__('must accept terms')),
  });
```

**3. GET route - Display form:**
```typescript
router.get('/request-account', async (req, res, next) => {
  viewInSignupLanguage(req);
  try {
    render.template(req, res, 'request-account', {
      titleKey: 'request account',
      scripts: ['forms.js'],
      deferredScripts: ['register.js'],
    });
  } catch (error) {
    next(error);
  }
});
```

**4. POST route - Handle submission:**
```typescript
router.post(
  '/request-account',
  limiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 requests per IP per hour
    message: 'Too many account requests from this IP',
  }),
  async (req, res, next) => {
    viewInSignupLanguage(req);

    // Validate form data
    const result = accountRequestSchema(req).safeParse(req.body);

    if (!result.success) {
      flashZodIssues(req, result.error.issues, issue =>
        formatZodIssueMessage(req, issue)
      );
      return render.template(req, res, 'request-account', {
        titleKey: 'request account',
        formValues: req.body,
        scripts: ['forms.js'],
        deferredScripts: ['register.js'],
      });
    }

    const formData = result.data;
    const email = formData.email.trim().toLowerCase();
    const ipAddress = req.ip;

    try {
      // Check IP rate limit
      const maxRequests = config.get<number>('accountRequests.rateLimitPerIP');
      const windowHours = config.get<number>('accountRequests.rateLimitWindowHours');
      const ipLimitExceeded = await AccountRequest.checkIPRateLimit(
        ipAddress,
        maxRequests,
        windowHours
      );

      if (ipLimitExceeded) {
        req.flash('pageErrors', res.__('account request rate limit exceeded'));
        return render.template(req, res, 'request-account', {
          titleKey: 'request account',
          formValues: req.body,
          scripts: ['forms.js'],
          deferredScripts: ['register.js'],
        });
      }

      // Check email cooldown
      const cooldownHours = config.get<number>('accountRequests.emailCooldownHours');
      const hasRecent = await AccountRequest.hasRecentRequest(email, cooldownHours);

      if (hasRecent) {
        req.flash('pageErrors', res.__('account request already pending'));
        return render.template(req, res, 'request-account', {
          titleKey: 'request account',
          formValues: req.body,
          scripts: ['forms.js'],
          deferredScripts: ['register.js'],
        });
      }

      // Create the request
      const request = await AccountRequest.createRequest({
        plannedReviews: formData.plannedReviews.trim(),
        languages: formData.languages.trim(),
        aboutURL: formData.aboutURL.trim(),
        email,
        termsAccepted: true,
        ipAddress,
      });

      // Send notification to moderators (async, don't block)
      const language = req.language || 'en';
      sendAccountRequestNotification(request.id, language).catch(error => {
        debug.error(`Failed to send moderator notification: ${error}`);
      });

      // Success message
      req.flash('siteMessages', res.__('account request submitted'));
      return res.redirect('/');
    } catch (error) {
      next(error);
    }
  }
);
```

**5. Update register route to redirect when invite-only:**

Modify the existing GET `/register` route (around line 467):

```typescript
router.get('/register', async (req, res, next) => {
  viewInSignupLanguage(req);
  if (config.requireInviteLinks)
    // Redirect to account request form instead of showing invite-needed page
    return res.redirect('/actions/request-account');
  else
    try {
      await sendRegistrationForm(req, res);
    } catch (error) {
      next(error);
    }
});
```

### Phase 6: Moderator Management Interface

**File: `routes/actions.ts`**

Add the management route (moderator-only):

**1. GET route - Display queue with tabs:**
```typescript
router.get('/manage-requests', signinRequiredRoute, async (req, res, next) => {
  // Check if user is site moderator
  if (!req.user?.isSiteModerator) {
    return render.permissionError(req, res, {
      titleKey: 'manage account requests',
      detailsKey: 'must be site moderator',
    });
  }

  try {
    // Get pending requests (main tab)
    const pendingRequests = await AccountRequest.getPending();

    // Get moderated requests (moderator log tab)
    const moderatedRequests = await AccountRequest.getModerated(100);

    render.template(req, res, 'manage-account-requests', {
      titleKey: 'manage account requests',
      pendingRequests,
      moderatedRequests,
      scripts: ['forms.js'],
    });
  } catch (error) {
    next(error);
  }
});
```

**2. POST route - Handle moderation actions:**
```typescript
router.post('/manage-requests', signinRequiredRoute, async (req, res, next) => {
  // Check if user is site moderator
  if (!req.user?.isSiteModerator) {
    return render.permissionError(req, res, {
      titleKey: 'manage account requests',
      detailsKey: 'must be site moderator',
    });
  }

  const { requestId, action, rejectionReason } = req.body;

  if (!requestId || !action) {
    req.flash('pageErrors', res.__('invalid request'));
    return res.redirect('/actions/manage-requests');
  }

  try {
    const request = await AccountRequest.get(requestId);

    if (request.status !== 'pending') {
      req.flash('pageErrors', res.__('request already processed'));
      return res.redirect('/actions/manage-requests');
    }

    if (action === 'approve') {
      // Import models
      const InviteLink = (await import('../models/invite-link.ts')).default;
      const User = (await import('../models/user.ts')).default;

      // Create invite link
      const inviteLink = new InviteLink({
        createdBy: req.user.id,
        createdOn: new Date(),
      });
      await inviteLink.save();

      // Update request
      request.status = 'approved';
      request.moderatedBy = req.user.id;
      request.moderatedAt = new Date();
      request.inviteLinkID = inviteLink.id;
      await request.save();

      // Send approval email with invite code
      const language = req.language || 'en';
      sendAccountRequestApproval(request.email, inviteLink.id, language).catch(
        error => {
          debug.error(`Failed to send approval email: ${error}`);
        }
      );

      req.flash('siteMessages', res.__('account request approved'));
    } else if (action === 'reject') {
      // Update request
      request.status = 'rejected';
      request.moderatedBy = req.user.id;
      request.moderatedAt = new Date();

      if (rejectionReason && rejectionReason.trim()) {
        request.rejectionReason = rejectionReason.trim();

        // Send rejection email
        const language = req.language || 'en';
        sendAccountRequestRejection(
          request.email,
          request.rejectionReason,
          language
        ).catch(error => {
          debug.error(`Failed to send rejection email: ${error}`);
        });
      }

      await request.save();
      req.flash('siteMessages', res.__('account request rejected'));
    }

    return res.redirect('/actions/manage-requests');
  } catch (error) {
    next(error);
  }
});
```

### Phase 7: View Templates

**File: `views/request-account.hbs`**

Create the account request form:

```handlebars
<h1 class="page-heading">{{__ "request account"}}</h1>

<p>{{__ "request account intro"}}</p>

<form class="pure-form pure-form-stacked" action="/actions/request-account" method="post">
  {{>form-errors}}

  <input type="hidden" name="_csrf" value="{{csrfToken}}">

  <label for="planned-reviews">
    {{__ "what kind of reviews planning"}}
    <textarea
      id="planned-reviews"
      name="plannedReviews"
      rows="4"
      required
      class="full-width">{{#if formValues}}{{formValues.plannedReviews}}{{/if}}</textarea>
  </label>

  <label for="languages">
    {{__ "which languages interested"}}
    <input
      type="text"
      id="languages"
      name="languages"
      value="{{#if formValues}}{{formValues.languages}}{{/if}}"
      required
      class="full-width">
  </label>

  <label for="about-url">
    {{__ "where find out more about you"}}
    <input
      type="text"
      id="about-url"
      name="aboutURL"
      value="{{#if formValues}}{{formValues.aboutURL}}{{/if}}"
      required
      class="full-width"
      placeholder="https://">
  </label>

  <label for="email">
    {{__ "email for invite link"}}
    <input
      type="email"
      id="email"
      name="email"
      value="{{#if formValues}}{{formValues.email}}{{/if}}"
      required
      class="full-width">
  </label>

  <label for="terms-accepted" class="pure-checkbox">
    <input
      type="checkbox"
      id="terms-accepted"
      name="termsAccepted"
      required
      {{#if formValues.termsAccepted}}checked{{/if}}>
    {{__ "read and agree to terms"}}
  </label>

  <div class="button-group">
    <button type="submit" class="pure-button pure-button-primary">
      {{__ "submit request"}}
    </button>
  </div>
</form>
```

**File: `views/manage-account-requests.hbs`**

Create the moderator management interface with tabs:

```handlebars
<h1 class="page-heading">{{__ "manage account requests"}}</h1>

<div class="tabs">
  <button class="tab-button active" data-tab="pending">
    {{__ "pending requests"}} ({{pendingRequests.length}})
  </button>
  <button class="tab-button" data-tab="moderated">
    {{__ "moderator log"}}
  </button>
</div>

<!-- Pending Requests Tab -->
<div id="pending-tab" class="tab-content active">
  {{#if pendingRequests.length}}
    {{#each pendingRequests}}
      <div class="account-request">
        <div class="request-header">
          <strong>{{email}}</strong>
          <span class="request-date">{{formatDate createdAt}}</span>
        </div>

        <div class="request-body">
          <div class="request-field">
            <strong>{{__ "what kind of reviews planning"}}</strong>
            <p>{{plannedReviews}}</p>
          </div>

          <div class="request-field">
            <strong>{{__ "which languages interested"}}</strong>
            <p>{{languages}}</p>
          </div>

          <div class="request-field">
            <strong>{{__ "where find out more about you"}}</strong>
            <p>{{{autolink aboutURL}}}</p>
          </div>
        </div>

        <form class="request-actions pure-form" action="/actions/manage-requests" method="post">
          <input type="hidden" name="_csrf" value="{{../csrfToken}}">
          <input type="hidden" name="requestId" value="{{id}}">

          <div class="action-group">
            <button
              type="submit"
              name="action"
              value="approve"
              class="pure-button pure-button-primary">
              {{__ "approve request"}}
            </button>

            <button
              type="button"
              class="pure-button reject-button"
              data-request-id="{{id}}">
              {{__ "reject request"}}
            </button>
          </div>

          <div class="rejection-form hidden" id="rejection-{{id}}">
            <label for="rejection-reason-{{id}}">
              {{__ "rejection reason optional"}}
              <textarea
                id="rejection-reason-{{id}}"
                name="rejectionReason"
                rows="3"
                class="full-width"></textarea>
            </label>
            <button
              type="submit"
              name="action"
              value="reject"
              class="pure-button pure-button-warning">
              {{__ "confirm rejection"}}
            </button>
            <button
              type="button"
              class="pure-button cancel-reject"
              data-request-id="{{id}}">
              {{__ "cancel"}}
            </button>
          </div>
        </form>
      </div>
    {{/each}}
  {{else}}
    <p class="no-requests">{{__ "no pending requests"}}</p>
  {{/if}}
</div>

<!-- Moderator Log Tab -->
<div id="moderated-tab" class="tab-content">
  {{#if moderatedRequests.length}}
    <table class="pure-table pure-table-horizontal full-width">
      <thead>
        <tr>
          <th>{{__ "email"}}</th>
          <th>{{__ "requested"}}</th>
          <th>{{__ "action"}}</th>
          <th>{{__ "moderator"}}</th>
          <th>{{__ "moderated at"}}</th>
        </tr>
      </thead>
      <tbody>
        {{#each moderatedRequests}}
          <tr>
            <td>{{email}}</td>
            <td>{{formatDate createdAt}}</td>
            <td>
              <span class="status-{{status}}">{{__ status}}</span>
              {{#if rejectionReason}}
                <br><small>{{rejectionReason}}</small>
              {{/if}}
            </td>
            <td>{{moderator.displayName}}</td>
            <td>{{formatDate moderatedAt}}</td>
          </tr>
        {{/each}}
      </tbody>
    </table>
  {{else}}
    <p class="no-requests">{{__ "no moderated requests"}}</p>
  {{/if}}
</div>

<script>
  // Tab switching
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', function() {
      const tabName = this.dataset.tab;

      // Update buttons
      document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
      this.classList.add('active');

      // Update content
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.getElementById(tabName + '-tab').classList.add('active');
    });
  });

  // Rejection form toggle
  document.querySelectorAll('.reject-button').forEach(button => {
    button.addEventListener('click', function() {
      const requestId = this.dataset.requestId;
      document.getElementById('rejection-' + requestId).classList.remove('hidden');
      this.closest('.action-group').classList.add('hidden');
    });
  });

  document.querySelectorAll('.cancel-reject').forEach(button => {
    button.addEventListener('click', function() {
      const requestId = this.dataset.requestId;
      document.getElementById('rejection-' + requestId).classList.add('hidden');
      this.closest('form').querySelector('.action-group').classList.remove('hidden');
    });
  });
</script>
```

### Phase 8: Localization

**File: `locales/en.json`**

Add translation keys (add in appropriate sections):

```json
{
  "request account": "Request Account",
  "request account intro": "We're currently in invite-only mode. Please fill out this form to request an account, and a moderator will review your request.",
  "what kind of reviews planning": "What kind of reviews are you planning to write?",
  "which languages interested": "Which language(s) are you interested in writing in?",
  "where find out more about you": "Where can we find out more about you or anything else you've written?",
  "email for invite link": "Which email address should we use to send you an invite link?",
  "read and agree to terms": "I've read the terms of use and agree to abide by them",
  "submit request": "Submit Request",
  "account request submitted": "Your account request has been submitted. A moderator will review it and email you at the address you provided.",
  "account request need planned reviews": "Please tell us what kind of reviews you plan to write",
  "account request need languages": "Please tell us which languages you're interested in",
  "account request need about url": "Please provide a URL where we can learn more about you",
  "account request rate limit exceeded": "You've submitted too many requests. Please try again later.",
  "account request already pending": "You already have a pending request with this email address.",
  "manage account requests": "Manage Account Requests",
  "pending requests": "Pending Requests",
  "moderator log": "Moderator Log",
  "approve request": "Approve",
  "reject request": "Reject",
  "rejection reason optional": "Rejection reason (optional - will be sent to requester if provided):",
  "confirm rejection": "Confirm Rejection",
  "no pending requests": "No pending requests.",
  "no moderated requests": "No actions taken yet.",
  "account request approved": "Account request approved. An invite code has been sent to the requester.",
  "account request rejected": "Account request rejected.",
  "must be site moderator": "You must be a site moderator to access this page.",
  "requested": "Requested",
  "action": "Action",
  "moderator": "Moderator",
  "moderated at": "Moderated At",
  "approved": "Approved",
  "rejected": "Rejected",

  // Email message keys - Moderator Notification
  "account request notification subject": "New Account Request - lib.reviews",
  "account request notification greeting": "Hello,",
  "account request notification intro": "A new user has requested an account on <a href=\"https://lib.reviews\">lib.reviews</a>.",
  "account request notification intro plain": "A new user has requested an account on lib.reviews.",
  "account request notification instructions": "To review and manage account requests, visit:",
  "account request notification instructions plain": "To review and manage account requests, visit:",
  "account request notification action info": "You can approve the request (which will send an invite code) or reject it (with an optional rejection message).",
  "account request notification action info plain": "You can approve the request (which will send an invite code) or reject it (with an optional rejection message).",
  "account request notification signature": "Best regards,<br>The lib.reviews team",
  "account request notification signature plain": "Best regards,\nThe lib.reviews team",

  // Email message keys - Approval
  "account request approval subject": "Your lib.reviews Account Request Has Been Approved",
  "account request approval greeting": "Hello,",
  "account request approval intro": "Good news! Your request for a <a href=\"https://lib.reviews\">lib.reviews</a> account has been approved.",
  "account request approval intro plain": "Good news! Your request for a lib.reviews account has been approved.",
  "account request approval instructions": "To complete your registration, visit this link:",
  "account request approval instructions plain": "To complete your registration, visit this link:",
  "account request approval next steps": "This link will allow you to create your account and start writing reviews.",
  "account request approval next steps plain": "This link will allow you to create your account and start writing reviews.",
  "account request approval contact": "If you have any questions, please contact us at <a href=\"mailto:lib.reviews@permacommons.org\">lib.reviews@permacommons.org</a>.",
  "account request approval contact plain": "If you have any questions, please contact us at lib.reviews@permacommons.org.",
  "account request approval signature": "Best regards,<br>The lib.reviews team",
  "account request approval signature plain": "Best regards,\nThe lib.reviews team",

  // Email message keys - Rejection
  "account request rejection subject": "Update on Your lib.reviews Account Request",
  "account request rejection greeting": "Hello,",
  "account request rejection intro": "Thank you for your interest in <a href=\"https://lib.reviews\">lib.reviews</a>. Unfortunately, we're unable to approve your account request at this time.",
  "account request rejection intro plain": "Thank you for your interest in lib.reviews. Unfortunately, we're unable to approve your account request at this time.",
  "account request rejection reason label": "Reason:",
  "account request rejection reason label plain": "Reason:",
  "account request rejection contact": "If you have any questions, please contact us at <a href=\"mailto:lib.reviews@permacommons.org\">lib.reviews@permacommons.org</a>.",
  "account request rejection contact plain": "If you have any questions, please contact us at lib.reviews@permacommons.org.",
  "account request rejection signature": "Best regards,<br>The lib.reviews team",
  "account request rejection signature plain": "Best regards,\nThe lib.reviews team"
}
```

**File: `locales/qqq.json`** (documentation for translators)

Add documentation for the new message keys:

```json
{
  "account request notification subject": "Subject line for the email sent to moderators when a new account request is submitted.",
  "account request notification greeting": "Greeting at the start of the moderator notification email.",
  "account request notification intro": "HTML version explaining that a new account request has been submitted. Contains a link to lib.reviews.",
  "account request notification intro plain": "Plain text version explaining that a new account request has been submitted.",
  "account request notification instructions": "HTML version telling moderators where to go to manage requests.",
  "account request notification instructions plain": "Plain text version telling moderators where to go to manage requests.",
  "account request notification action info": "HTML version explaining what actions moderators can take.",
  "account request notification action info plain": "Plain text version explaining what actions moderators can take.",
  "account request notification signature": "HTML version of the email signature with line break tag.",
  "account request notification signature plain": "Plain text version of the email signature with newline.",

  "account request approval subject": "Subject line for the email sent when an account request is approved.",
  "account request approval greeting": "Greeting at the start of the approval email.",
  "account request approval intro": "HTML version announcing that the request has been approved. Contains a link to lib.reviews.",
  "account request approval intro plain": "Plain text version announcing that the request has been approved.",
  "account request approval instructions": "HTML version telling the user where to complete registration.",
  "account request approval instructions plain": "Plain text version telling the user where to complete registration.",
  "account request approval next steps": "HTML version explaining what the user can do after registering.",
  "account request approval next steps plain": "Plain text version explaining what the user can do after registering.",
  "account request approval contact": "HTML version of contact information with a mailto link.",
  "account request approval contact plain": "Plain text version of contact information.",
  "account request approval signature": "HTML version of the email signature with line break tag.",
  "account request approval signature plain": "Plain text version of the email signature with newline.",

  "account request rejection subject": "Subject line for the email sent when an account request is rejected.",
  "account request rejection greeting": "Greeting at the start of the rejection email.",
  "account request rejection intro": "HTML version explaining that the request was not approved. Contains a link to lib.reviews.",
  "account request rejection intro plain": "Plain text version explaining that the request was not approved.",
  "account request rejection reason label": "HTML version of the label for the rejection reason field.",
  "account request rejection reason label plain": "Plain text version of the label for the rejection reason field.",
  "account request rejection contact": "HTML version of contact information with a mailto link.",
  "account request rejection contact plain": "Plain text version of contact information.",
  "account request rejection signature": "HTML version of the email signature with line break tag.",
  "account request rejection signature plain": "Plain text version of the email signature with newline."
}
```

### Phase 9: Maintenance Cleanup Script

**File: `maintenance/cleanup-account-requests.ts`**

Create the 90-day retention cleanup script:

```typescript
import { initializeDAL } from '../bootstrap/dal.ts';
import AccountRequest from '../models/account-request.ts';
import config from '../config.ts';
import debug from '../util/debug.ts';

debug.util.enabled = true;
debug.errorLog.enabled = true;

const RETENTION_DAYS = config.get<number>('accountRequests.retentionDays') || 90;

async function cleanupAccountRequests(): Promise<void> {
  await initializeDAL();

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Only delete approved/rejected requests, never pending ones
  const deleted = await AccountRequest.filterWhere({
    status: AccountRequest.ops.neq('pending'),
    createdAt: AccountRequest.ops.lt(cutoff),
  }).delete();

  debug.util(
    `Account request cleanup: deleted ${deleted} approved/rejected requests created before ${cutoff.toISOString()} (retention ${RETENTION_DAYS} days)`
  );
}

cleanupAccountRequests()
  .then(() => process.exit(0))
  .catch(error => {
    debug.error('Problem cleaning up account requests:', error);
    process.exit(1);
  });
```

**Schedule in cron** (documentation for deployment):
```bash
# Run cleanup daily at 3 AM
0 3 * * * cd /path/to/lib.reviews && npx tsx maintenance/cleanup-account-requests.ts
```

### Phase 10: CSS Styling

**File: `static/css/main.css`** (or appropriate stylesheet)

Add styles for the account request components:

```css
/* Account Request Form */
.account-request textarea,
.account-request input[type="text"],
.account-request input[type="email"] {
  width: 100%;
  box-sizing: border-box;
}

/* Tabs */
.tabs {
  display: flex;
  border-bottom: 2px solid #e0e0e0;
  margin-bottom: 2rem;
}

.tab-button {
  background: none;
  border: none;
  padding: 1rem 1.5rem;
  cursor: pointer;
  font-size: 1rem;
  color: #666;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: all 0.3s;
}

.tab-button:hover {
  color: #333;
}

.tab-button.active {
  color: #0078e7;
  border-bottom-color: #0078e7;
}

.tab-content {
  display: none;
}

.tab-content.active {
  display: block;
}

/* Account Request Cards */
.account-request {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  background: #fff;
}

.request-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.request-date {
  color: #666;
  font-size: 0.9rem;
}

.request-body {
  margin-bottom: 1rem;
}

.request-field {
  margin-bottom: 1rem;
}

.request-field strong {
  display: block;
  margin-bottom: 0.25rem;
  color: #333;
}

.request-field p {
  margin: 0;
  color: #666;
  white-space: pre-wrap;
}

.request-actions {
  margin-top: 1rem;
}

.action-group {
  display: flex;
  gap: 0.5rem;
}

.rejection-form {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e0e0e0;
}

.rejection-form.hidden {
  display: none;
}

.action-group.hidden {
  display: none;
}

/* Status badges */
.status-approved {
  color: #0c6;
  font-weight: bold;
}

.status-rejected {
  color: #c00;
  font-weight: bold;
}

.no-requests {
  color: #666;
  font-style: italic;
  text-align: center;
  padding: 2rem;
}
```

### Phase 11: Helper Functions

**File: `routes/helpers/formatters.ts`** (or appropriate helper file)

Add URL autolinking helper for the moderator view:

```typescript
import { escape } from 'he';

/**
 * Convert URLs in text to clickable links
 */
export function autolink(text: string): string {
  if (!text) return '';

  const escaped = escape(text);
  const urlRegex = /(https?:\/\/[^\s]+)/g;

  return escaped.replace(urlRegex, url => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}
```

Register this helper in your Handlebars setup (typically in `app.ts` or template engine configuration):

```typescript
import { autolink } from './routes/helpers/formatters.ts';

hbs.registerHelper('autolink', autolink);
```

### Phase 12: Testing

**File: `tests/account-request.test.ts`**

Create comprehensive tests:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { initializeDAL } from '../bootstrap/dal.ts';
import AccountRequest from '../models/account-request.ts';
import { mockMailgunMessageSuccess } from './helpers/mailgun-mocks.ts';

describe('Account Request', () => {
  before(async () => {
    await initializeDAL();
    mockMailgunMessageSuccess({ domain: 'test.com' });
  });

  after(async () => {
    // Cleanup test data
    await AccountRequest.filterWhere({
      email: AccountRequest.ops.like('%@test.example.com'),
    }).delete();
  });

  describe('Model', () => {
    it('should create a new account request', async () => {
      const request = await AccountRequest.createRequest({
        plannedReviews: 'Book reviews',
        languages: 'English, Spanish',
        aboutURL: 'https://example.com',
        email: 'test@test.example.com',
        termsAccepted: true,
        ipAddress: '127.0.0.1',
      });

      assert.ok(request.id);
      assert.strictEqual(request.status, 'pending');
      assert.strictEqual(request.email, 'test@test.example.com');
    });

    it('should check IP rate limiting', async () => {
      // Create multiple requests from same IP
      for (let i = 0; i < 3; i++) {
        await AccountRequest.createRequest({
          plannedReviews: 'Test',
          languages: 'English',
          aboutURL: 'https://example.com',
          email: `test${i}@test.example.com`,
          termsAccepted: true,
          ipAddress: '192.168.1.1',
        });
      }

      const limitExceeded = await AccountRequest.checkIPRateLimit(
        '192.168.1.1',
        3,
        24
      );
      assert.strictEqual(limitExceeded, true);
    });

    it('should check email cooldown', async () => {
      await AccountRequest.createRequest({
        plannedReviews: 'Test',
        languages: 'English',
        aboutURL: 'https://example.com',
        email: 'cooldown@test.example.com',
        termsAccepted: true,
      });

      const hasRecent = await AccountRequest.hasRecentRequest(
        'cooldown@test.example.com',
        24
      );
      assert.strictEqual(hasRecent, true);
    });
  });

  describe('Queue Management', () => {
    it('should retrieve pending requests', async () => {
      const pending = await AccountRequest.getPending();
      assert.ok(Array.isArray(pending));
    });

    it('should retrieve moderated requests', async () => {
      const moderated = await AccountRequest.getModerated(10);
      assert.ok(Array.isArray(moderated));
    });
  });
});
```

### Phase 13: Documentation

**File: `docs/account-requests.md`** (create if docs directory exists)

Document the feature for administrators:

```markdown
# Account Request System

## Overview

The account request system allows site visitors to request accounts when the site is in invite-only mode (`requireInviteLinks: true`).

## Configuration

Edit `config/default.json5`:

```json5
accountRequests: {
  rateLimitPerIP: 3,           // Max requests per IP address
  rateLimitWindowHours: 24,    // Rate limit time window
  emailCooldownHours: 24,      // Prevent duplicate email requests
  retentionDays: 90,           // Keep approved/rejected for 90 days
}
```

## Moderator Workflow

1. **Receive notification**: When a request is submitted, all moderators with email addresses receive a notification
2. **Review queue**: Visit `/actions/manage-requests` to see pending requests
3. **Take action**:
   - **Approve**: Generates an invite code and emails it to the requester
   - **Reject**: Optionally include a rejection reason to email to the requester
   - **No action**: Request stays in queue

## Maintenance

Run the cleanup script regularly (recommended: daily via cron):

```bash
npx tsx maintenance/cleanup-account-requests.ts
```

This removes approved/rejected requests older than the configured retention period (default: 90 days).

## Email Templates

Email templates are located in `views/email/` and use the i18n system for all text:
- `account-request-notification.txt/hbs` - Moderator notifications
- `account-request-approval.txt/hbs` - Approval emails with invite codes
- `account-request-rejection.txt/hbs` - Rejection emails (optional)

Templates use `{{__ "message key"}}` to reference translatable strings in `locales/*.json`. The subject line is extracted from locale strings (e.g., `"account request notification subject"`), not from template files.

Currently supported languages: English (en), German (de)

To add a new language:
1. Add all message keys to `locales/{lang}.json` following the pattern in `locales/en.json`
2. Templates automatically use the appropriate language based on user preference
3. No need to create separate template files per language
```

## Implementation Checklist

### Phase 1: Database Foundation
- [ ] Create migration `003_account_requests.sql`
- [ ] Create rollback migration `down/003_account_requests.sql`
- [ ] Test migration by restarting app or running migration script

### Phase 2: Model Layer
- [ ] Create `models/manifests/account-request.ts`
- [ ] Create `models/account-request.ts`
- [ ] Add model import to `bootstrap/dal.ts`

### Phase 3: Email Notifications
- [ ] Add email functions to `util/email.ts` (3 functions using existing `loadEmailTemplate`)
- [ ] Create 6 email template files in `views/email/` (plain text and HTML versions)
- [ ] Templates use `{{__ "message key"}}` pattern, not hardcoded text
- [ ] Test email sending (requires Mailgun configuration or mocking)

### Phase 4: Configuration
- [ ] Add `accountRequests` config to `config/default.json5`
- [ ] Add TypeScript types to `types/config.d.ts`

### Phase 5: Request Submission Route
- [ ] Add imports and Zod schema to `routes/actions.ts`
- [ ] Add GET `/actions/request-account` route
- [ ] Add POST `/actions/request-account` route with rate limiting
- [ ] Update GET `/register` route to redirect when invite-only

### Phase 6: Moderator Management Interface
- [ ] Add GET `/actions/manage-requests` route
- [ ] Add POST `/actions/manage-requests` route

### Phase 7: View Templates
- [ ] Create `views/request-account.hbs`
- [ ] Create `views/manage-account-requests.hbs`

### Phase 8: Localization
- [ ] Add all UI translation keys to `locales/en.json` (~30 keys for forms and interface)
- [ ] Add all email message keys to `locales/en.json` (~30 keys for email templates)
- [ ] Add documentation to `locales/qqq.json` for translator guidance
- [ ] (Optional) Add German translations to `locales/de.json`

### Phase 9: Maintenance Cleanup Script
- [ ] Create `maintenance/cleanup-account-requests.ts`
- [ ] Schedule in cron (deployment documentation)

### Phase 10: CSS Styling
- [ ] Add styles to appropriate CSS file

### Phase 11: Helper Functions
- [ ] Add `autolink` helper to formatters
- [ ] Register helper in Handlebars configuration

### Phase 12: Testing
- [ ] Create `tests/account-request.test.ts`
- [ ] Run tests and verify all pass

### Phase 13: Documentation
- [ ] Create documentation in `docs/` (if applicable)
- [ ] Update README or admin docs with feature information

## Notes & Considerations

### Security
- **CSRF Protection**: All forms include CSRF tokens via existing middleware
- **Rate Limiting**: IP-based rate limiting on submission (5 per hour) + configurable per-IP limits
- **Email Validation**: Zod schema validates email format
- **Moderator-Only Routes**: Management interface checks `isSiteModerator` flag
- **SQL Injection**: Using parameterized queries via model layer
- **XSS Prevention**: Handlebars auto-escapes, URLs autolinked safely

### Performance
- **Indexes**: Added for common queries (status + created_at, moderator lookups)
- **Pagination**: Moderator log limited to 100 most recent (can be increased)
- **Async Emails**: Email sending doesn't block request/response cycle

### Scalability
- **Large Queue**: If pending requests grow large, consider pagination on pending tab
- **Email Load**: Moderator notifications sent to all moderators individually (could batch if needed)
- **Cleanup**: Regular cleanup prevents table bloat

### User Experience
- **Clear Feedback**: Flash messages for all actions
- **Inline Rejection**: Rejection form appears inline without page reload
- **Tabs**: Separate pending and log views reduce clutter
- **Auto-linking**: URLs in "about" field automatically become clickable

### Future Enhancements (Not in Scope)
- Search/filter in moderator queue
- Bulk actions (approve/reject multiple)
- Request statistics/analytics
- Moderator assignment (specific mod handles specific request)
- Request comments/notes (internal mod discussion)
- Automated approval based on criteria

## Related Code Patterns

This feature follows established patterns from:
- **Password reset** (`002_password_reset.sql`, `models/password-reset-token.ts`, email templates)
- **Invite links** (`models/invite-link.ts`, registration flow)
- **Team join requests** (`team_join_requests` table structure)

Refer to these implementations for consistency.