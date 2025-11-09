-- Migration 0002: Add context and slide_url columns, make note nullable
-- Step 1: Create new table with updated schema
CREATE TABLE IF NOT EXISTS entries_new (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  note TEXT,
  context TEXT NOT NULL DEFAULT '',
  slide_url TEXT,
  hostname TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  synced_to_notion INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);

-- Step 2: Copy data from old table to new table
INSERT INTO entries_new (id, url, note, context, slide_url, hostname, tags, created_at, synced_to_notion, synced_at)
SELECT id, url, note, '' AS context, NULL AS slide_url, hostname, tags, created_at, synced_to_notion, synced_at
FROM entries;

-- Step 3: Drop old table
DROP TABLE entries;

-- Step 4: Rename new table to original name
ALTER TABLE entries_new RENAME TO entries;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries (datetime(created_at) DESC);
CREATE INDEX IF NOT EXISTS idx_entries_synced ON entries (synced_to_notion, datetime(created_at));
