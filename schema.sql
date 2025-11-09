CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  note TEXT NOT NULL,
  hostname TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  synced_to_notion INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (datetime(created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_entries_synced ON entries (synced_to_notion, datetime(created_at));
