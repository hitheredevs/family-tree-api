CREATE TABLE IF NOT EXISTS password_link_token (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  purpose       VARCHAR(30) NOT NULL CHECK (purpose IN ('setup-password', 'reset-password')),
  token_hash    VARCHAR(64) NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_by    UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_link_token_user
  ON password_link_token(user_id, purpose, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_link_token_active
  ON password_link_token(expires_at)
  WHERE used_at IS NULL;
