export const BROKER_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  slot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  last_message_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peers (
  peer_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('claude', 'codex')),
  workspace_root TEXT NOT NULL,
  slot TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT NOT NULL,
  git_root TEXT,
  pane_target TEXT,
  wake_method TEXT NOT NULL DEFAULT 'none'
    CHECK (wake_method IN ('none', 'mux_send_keys', 'http_post')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active', 'stale', 'closed')),
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_peer_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('claude', 'codex')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('claude', 'codex')),
  content TEXT NOT NULL,
  content_preview TEXT NOT NULL DEFAULT '',
  attachment_count INTEGER NOT NULL DEFAULT 0,
  requires_attachment_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE TABLE IF NOT EXISTS receipts (
  conversation_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('claude', 'codex')),
  last_ack_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, recipient_kind),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_peers_conv_kind_status
  ON peers(conversation_id, agent_kind, status);

CREATE INDEX IF NOT EXISTS idx_messages_conv_recipient_seq
  ON messages(conversation_id, recipient_kind, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conversation
  ON conversations(workspace_root, slot)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_peer_per_kind
  ON peers(workspace_root, slot, agent_kind)
  WHERE status = 'active';
`;
