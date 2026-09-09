import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../../lina-core/src/protocol.ts";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { DurableStore } from "../../lina-core/src/store.ts";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { openPersonaSourceOwner } from "../src/persona/source-owner.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";

const roots: string[] = [];
const closers: { close(): void }[] = [];

function keep<T extends { close(): void }>(resource: T): T {
	closers.push(resource);
	return resource;
}

function agentRoot(botId = "lina") {
	const root = mkdtempSync(join(tmpdir(), "lina-persona-source-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	const sessionFile = join(root, "session.jsonl");
	writeFileSync(sessionFile, "");
	const binding: BotBinding = {
		version: 1,
		botId,
		sessionId: `session-${botId}`,
		sessionFile,
		workspace,
	};
	writeFileSync(join(root, "binding.json"), `${JSON.stringify(binding)}\n`);
	return { root, binding };
}

afterEach(() => {
	for (const resource of closers.splice(0).reverse()) resource.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("opens existing journal and mind without creating an app, lease, or model factory", () => {
	const { root, binding } = agentRoot();
	const journalPath = join(root, "state.sqlite");
	const mindPath = join(root, "mind.sqlite");
	const journal = keep(new DurableStore(journalPath, binding));
	trustNativeFixture(journal, binding);
	journal.createRequest("r1", "I enjoy hiking.");
	journal.appendEntry({
		entryId: "u1",
		role: "user",
		text: "I enjoy hiking.",
		timestamp: "2026-09-08T00:00:00.000Z",
		raw: {},
	});
	journal.setRequest("r1", "accepted", { entryId: "u1" });
	journal.setRequest("r1", "settled");
	const lookup = (id: string) => journal.sourceEntry(id);
	const mind = keep(new EngineStore(mindPath, binding, { lookup }));
	mind.apply({
		sourceProofs: captureSourceProofs(["u1"], lookup),
		requestId: "r1",
		expectedRevision: 0,
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: "outdoors",
				text: "Enjoys hiking",
				evidence: "inferred",
				sources: [{ entryId: "u1", quote: "I enjoy hiking." }],
			},
		],
	});
	mind.close();
	journal.close();
	const db = readFileSync(journalPath);
	const wal = existsSync(`${journalPath}-wal`)
		? readFileSync(`${journalPath}-wal`)
		: undefined;
	const mindBytes = readFileSync(mindPath);
	const owner = keep(
		openPersonaSourceOwner({
			stateRoot: root,
			botId: binding.botId,
			workspace: binding.workspace,
		}),
	);
	expect(owner.binding()).toEqual(binding);
	expect(owner.journal().entry("u1")?.text).toBe("I enjoy hiking.");
	expect(owner.mind().state().records[0]?.text).toBe("Enjoys hiking");
	expect(owner.mind().currentRevision()).toBe(1);
	expect(
		owner
			.mind()
			.reasoningCandidates()
			.map((record) => record.key),
	).toEqual(["outdoors"]);
	expect(
		owner
			.mind()
			.currentRecords([owner.mind().reasoningCandidates()[0]?.id ?? ""]),
	).toBe(true);
	expect(() =>
		(owner.journal() as DurableStore).appendEntry({
			entryId: "u2",
			role: "user",
			text: "nope",
			timestamp: "2026-09-08T00:00:00.000Z",
			raw: {},
		}),
	).toThrow(/readonly/i);
	expect(() =>
		(owner.mind() as EngineStore).apply({
			sourceProofs: captureSourceProofs(["u1"], (id) =>
				owner.journal().sourceEntry(id),
			),
			requestId: "r2",
			expectedRevision: 1,
			observations: [
				{
					subject: "user",
					kind: "interest",
					key: "outdoors",
					text: "changed",
					evidence: "inferred",
					sources: [{ entryId: "u1", quote: "I enjoy hiking." }],
				},
			],
		}),
	).toThrow(/readonly/i);
	expect(readFileSync(journalPath)).toEqual(db);
	if (wal) expect(readFileSync(`${journalPath}-wal`)).toEqual(wal);
	expect(readFileSync(mindPath)).toEqual(mindBytes);
	expect(existsSync(join(root, "owner.sqlite"))).toBe(false);
});

test("rejects foreign binding, missing files, and legacy schema without creating databases", () => {
	const { root, binding } = agentRoot();
	expect(() =>
		openPersonaSourceOwner({
			stateRoot: root,
			botId: "other",
			workspace: binding.workspace,
		}),
	).toThrow(/foreign/i);
	expect(existsSync(join(root, "state.sqlite"))).toBe(false);
	expect(existsSync(join(root, "mind.sqlite"))).toBe(false);
	expect(() =>
		openPersonaSourceOwner({
			stateRoot: root,
			botId: binding.botId,
			workspace: binding.workspace,
		}),
	).toThrow();
	const journal = keep(new DurableStore(join(root, "state.sqlite"), binding));
	journal.close();
	const db = new DatabaseSync(join(root, "state.sqlite"));
	db.exec("PRAGMA user_version = 1");
	db.close();
	const before = readFileSync(join(root, "state.sqlite"));
	expect(() =>
		openPersonaSourceOwner({
			stateRoot: root,
			botId: binding.botId,
			workspace: binding.workspace,
		}),
	).toThrow(/migration|schema/i);
	expect(readFileSync(join(root, "state.sqlite"))).toEqual(before);
});

test("owner clock injection hides expired records without writing", () => {
	const { root, binding } = agentRoot();
	const writtenAt = 1_800_000_000_000;
	let now = writtenAt;
	const journal = keep(new DurableStore(join(root, "state.sqlite"), binding));
	trustNativeFixture(journal, binding);
	journal.createRequest("r1", "I enjoy hiking.");
	journal.appendEntry({
		entryId: "u1",
		role: "user",
		text: "I enjoy hiking.",
		timestamp: new Date(writtenAt).toISOString(),
		raw: {},
	});
	journal.setRequest("r1", "accepted", { entryId: "u1" });
	journal.setRequest("r1", "settled");
	const mind = keep(
		new EngineStore(join(root, "mind.sqlite"), binding, {
			now: () => writtenAt,
			lookup: (id) => journal.sourceEntry(id),
		}),
	);
	mind.apply({
		sourceProofs: captureSourceProofs(["u1"], (id) => journal.sourceEntry(id)),
		requestId: "r1",
		expectedRevision: 0,
		observations: [
			{
				subject: "user",
				kind: "mood",
				key: "hopeful",
				text: "Hopeful",
				evidence: "inferred",
				sources: [{ entryId: "u1", quote: "I enjoy hiking." }],
			},
		],
	});
	mind.close();
	journal.close();
	const live = keep(
		openPersonaSourceOwner(
			{
				stateRoot: root,
				botId: binding.botId,
				workspace: binding.workspace,
			},
			{ now: () => now },
		),
	);
	expect(live.mind().reasoningCandidates()).toHaveLength(1);
	live.close();
	now += 7 * 60 * 60 * 1000;
	const expired = keep(
		openPersonaSourceOwner({
			stateRoot: root,
			botId: binding.botId,
			workspace: binding.workspace,
			now: () => now,
		}),
	);
	expect(expired.mind().reasoningCandidates()).toEqual([]);
});

test("reads a published binding without taking a session lease", () => {
	const { root, binding } = agentRoot("guest");
	keep(new DurableStore(join(root, "state.sqlite"), binding)).close();
	keep(
		new EngineStore(join(root, "mind.sqlite"), binding, {
			lookup: () => undefined,
		}),
	).close();
	const owner = keep(
		openPersonaSourceOwner({
			stateRoot: root,
			botId: "guest",
			workspace: binding.workspace,
		}),
	);
	expect(owner.binding().botId).toBe("guest");
	expect(existsSync(join(root, "owner.sqlite"))).toBe(false);
});
