-- Migration 0003: Add tweet_embed_html column for storing oEmbed HTML
ALTER TABLE entries ADD COLUMN tweet_embed_html TEXT;
