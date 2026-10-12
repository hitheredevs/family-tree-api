-- Saved AI assistant chats (Ask tab). One session per conversation,
-- owned by the signed-in user; messages keep the tool steps and token
-- usage for later tuning. Both are soft-deleted via deleted_at.

CREATE TABLE IF NOT EXISTS ai_chat_session (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    title                VARCHAR(200) NOT NULL DEFAULT 'New chat',
    is_pinned            BOOLEAN NOT NULL DEFAULT false,
    message_count        INTEGER NOT NULL DEFAULT 0,
    last_message_preview TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_session_user
ON ai_chat_session (user_id, is_pinned DESC, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_chat_message (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id         UUID NOT NULL REFERENCES ai_chat_session(id) ON DELETE CASCADE,
    role               VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
    content            TEXT NOT NULL DEFAULT '',
    status             VARCHAR(10) NOT NULL DEFAULT 'complete'
                       CHECK (status IN ('complete', 'stopped', 'error')),
    error              TEXT,
    context_person_ids UUID[] NOT NULL DEFAULT '{}',
    tool_trace         JSONB,
    model              VARCHAR(64),
    prompt_tokens      INTEGER,
    completion_tokens  INTEGER,
    cached_tokens      INTEGER,
    latency_ms         INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_message_session
ON ai_chat_message (session_id, created_at)
WHERE deleted_at IS NULL;
