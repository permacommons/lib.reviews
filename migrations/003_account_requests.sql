-- Account requests table to handle invite-only signup workflow

CREATE TABLE account_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Request data
  planned_reviews TEXT NOT NULL,
  languages TEXT NOT NULL,
  about_links TEXT NOT NULL,
  email VARCHAR(128) NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  terms_accepted BOOLEAN NOT NULL DEFAULT TRUE,

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
