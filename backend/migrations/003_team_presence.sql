-- Team feed + presence
CREATE TABLE IF NOT EXISTS team_messages (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  by_label TEXT NOT NULL,
  handle TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  page TEXT
);

CREATE INDEX IF NOT EXISTS team_messages_created_at_idx ON team_messages (created_at DESC);

CREATE TABLE IF NOT EXISTS presence (
  user_sub TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  label TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  page TEXT
);

CREATE INDEX IF NOT EXISTS presence_last_seen_idx ON presence (last_seen DESC);
