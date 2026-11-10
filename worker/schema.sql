-- One row per payment a call is being run for, so the same signature can never buy two results.
-- Dropped again when the call fails before the money moves.
CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, at INTEGER NOT NULL);

-- Settled payments only. Every row has a real transaction with a Paid event from the till. value and fee are USDG units.
CREATE TABLE IF NOT EXISTS payments (
  tx TEXT PRIMARY KEY,
  stall TEXT NOT NULL,
  house INTEGER NOT NULL,
  seller TEXT NOT NULL,
  buyer TEXT NOT NULL,
  value INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  own INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_at ON payments (at DESC);

-- Stalls listed by sellers. pay_to signed the listing and is the only wallet that can change it.
CREATE TABLE IF NOT EXISTS stalls (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  docs TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  value INTEGER NOT NULL,
  pay_to TEXT NOT NULL,
  secret TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uses (day TEXT NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, who, kind));
