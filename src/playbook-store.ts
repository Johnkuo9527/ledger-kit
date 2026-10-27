/// Saving and reading playbook versions.
///
/// publishPlaybook writes a NEW version and moves the head to it in ONE batch,
/// guarded on the head the author started from (parent_version). If someone
/// else published in between, nothing is written and the caller is told —
/// it re-reads and tries again. A version is never edited or deleted.

import type { Bound, Db } from "./db";
import { canonicalJson, sha256Hex, validatePlaybook, type Playbook } from "./playbook";

export type PublishResult = { ok: true; version: number } | { ok: false; reason: "invalid"; problems: string[] } | { ok: false; reason: "conflict"; head: number | null };

export interface PlaybookHead {
	version: number;
	body: Playbook;
	body_sha256: string;
	created_at: string;
}

export async function readHead(db: Db): Promise<PlaybookHead | null> {
	const row = await db
		.prepare("SELECT v.version, v.body_json, v.body_sha256, v.created_at FROM playbook_head h JOIN playbook_versions v ON v.version = h.version WHERE h.id = 1")
		.bind()
		.first<{ version: number; body_json: string; body_sha256: string; created_at: string }>();
	return row ? { version: row.version, body: JSON.parse(row.body_json) as Playbook, body_sha256: row.body_sha256, created_at: row.created_at } : null;
}

/// The two statements that publish `body` as version `version` over `parentVersion`, for a caller
/// that must put them in its OWN batch (a category rename: the rules and the lines move together).
/// The first statement's meta.changes is 1 when it published; after it, the head reads `version`.
/// Refused (problems) when the body is not a valid playbook.
export async function publishStatements(
	db: Db,
	body: Playbook,
	parentVersion: number | null,
	author: "senior" | "owner",
	reason: string,
	now: string,
): Promise<{ ok: true; version: number; statements: [Bound, Bound] } | { ok: false; problems: string[] }> {
	const problems = validatePlaybook(body);
	if (problems.length) return { ok: false, problems };
	const json = canonicalJson(body);
	const sha = await sha256Hex(json);
	const max = await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM playbook_versions").bind().first<{ v: number }>();
	const version = (max?.v ?? 0) + 1;
	return {
		ok: true,
		version,
		statements: [
			// No aggregate in the outer SELECT: when the guard fails it yields NO
			// row (an aggregate would yield one row of NULLs, and an INTEGER
			// PRIMARY KEY given NULL silently picks its own number).
			db
				.prepare(
					"INSERT INTO playbook_versions (version, parent_version, author, reason, body_json, body_sha256, created_at) " +
						"SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT version FROM playbook_head WHERE id = 1) IS ?",
				)
				.bind(version, parentVersion, author, reason, json, sha, now, parentVersion),
			db
				.prepare(
					"INSERT INTO playbook_head (id, version, updated_at) SELECT 1, ?, ? WHERE EXISTS (SELECT 1 FROM playbook_versions WHERE version = ? AND body_sha256 = ?) " +
						"ON CONFLICT (id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at WHERE playbook_head.version IS ?",
				)
				.bind(version, now, version, sha, parentVersion),
		],
	};
}

export async function publishPlaybook(
	db: Db,
	body: Playbook,
	parentVersion: number | null,
	author: "senior" | "owner",
	reason: string,
	now: string,
): Promise<PublishResult> {
	const built = await publishStatements(db, body, parentVersion, author, reason, now);
	if (!built.ok) return { ok: false, reason: "invalid", problems: built.problems };
	try {
		const [inserted] = await db.batch(built.statements);
		if (inserted!.meta.changes === 1) return { ok: true, version: built.version };
	} catch {
		// Two authors took the same version number at once: the second loses.
	}
	const head = await db.prepare("SELECT version FROM playbook_head WHERE id = 1").bind().first<{ version: number }>();
	return { ok: false, reason: "conflict", head: head?.version ?? null };
}
