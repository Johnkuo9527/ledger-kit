-- (13 Oct 2026): reading on the owner's Claude SUBSCRIPTION instead of the
-- Anthropic API. With LEDGER_READER = "subscription" the worker calls no model:
-- every reading it would have asked the API for is written here as a task,
-- and the owner's scheduled Claude routines ("Ledger Reader" connector, /mcp-reader)
-- claim the open ones, read them and hand the answer back. The answer then goes
-- through exactly the path an API answer takes (worker/src/reader.ts).
-- Additive only.

CREATE TABLE reading_tasks (
	id TEXT PRIMARY KEY,
	-- What question this is, so asking it again finds this row: tier + task +
	-- (the content's hash, or a caller's own name for a question whose figures
	-- drift while it waits, e.g. the playbook summary).
	slot TEXT NOT NULL,
	-- Questions that replace one another (the escalations of the moment, the
	-- merchants to sort): a new one sets the older OPEN ones aside.
	grp TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('alert_unknown', 'receipt', 'statement', 'learn_pattern', 'escalation', 'summary', 'categorise')),
	tier TEXT NOT NULL CHECK (tier IN ('daily', 'senior')),
	-- SHA-256 of the content (its random fence markers taken out).
	content_key TEXT NOT NULL,
	-- Exactly what the API path would send: system prompt, user content, schema.
	system TEXT NOT NULL,
	user_content TEXT NOT NULL,
	schema_json TEXT NOT NULL,
	-- The work row (work.gmail_id) waiting on this reading, woken when it is answered.
	origin TEXT,
	-- open → claimed (a reader holds it, lease_until) → done | failed;
	-- expired (nobody asked for it again for 3 days) and superseded (a newer
	-- question took its place) are never served or used.
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'done', 'failed', 'expired', 'superseded')),
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
	lease_until TEXT,
	result_json TEXT,
	error TEXT,
	created_at TEXT NOT NULL,
	-- The last time the engine asked for it (an unanswered task nobody asks for expires).
	asked_at TEXT NOT NULL,
	claimed_at TEXT,
	done_at TEXT,
	-- The first time the engine used the answer.
	used_at TEXT,
	updated_at TEXT NOT NULL
);
CREATE INDEX reading_tasks_slot ON reading_tasks (slot, created_at);
CREATE INDEX reading_tasks_queue ON reading_tasks (status, tier, created_at);
CREATE INDEX reading_tasks_origin ON reading_tasks (origin);
