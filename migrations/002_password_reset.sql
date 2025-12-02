-- Password reset infrastructure

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email VARCHAR(128) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  ip_address INET,

  CONSTRAINT password_reset_tokens_user_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_password_reset_tokens_id_expires
  ON password_reset_tokens(id, expires_at)
  WHERE used_at IS NULL;

CREATE INDEX idx_password_reset_tokens_email_created
  ON password_reset_tokens(email, created_at DESC);
