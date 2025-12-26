-- Run this once on your Render Postgres database
-- Creates messages table for LaunchOps user-to-user messaging

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_sub TEXT NOT NULL,
  receiver_sub TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_sender_sub ON messages(sender_sub);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_sub ON messages(receiver_sub);
CREATE INDEX IF NOT EXISTS idx_messages_pair_time ON messages(sender_sub, receiver_sub, created_at DESC);
