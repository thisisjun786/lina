import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "../src/agents/store.ts";
import type { AgentInput } from "../src/agents/types.ts";
import type {
	AvatarAdmission,
	AvatarAsset,
	GeneratedAvatarCandidate,
	ManualAvatarInput,
} from "../src/agents/visual.ts";
import {
	requireVisualRecord,
	visualDigest,
	visualIdentityDigest,
} from "../src/agents/visual-validation.ts";

let dir: string, path: string, store: AgentStore;
const profile: AgentInput = {
	id: "lina",
	name: "Lina",
	role: "assistant",
	personality: "curious",
	voice: "warm",
	profile: "original lore",
	appearance: "eyes",
	interests: [],
	avatarId: null,
	evolution: "adaptive",
};
const settings = {
	anchors: ["eyes"],
	canonicalReferenceId: null,
	textIdentity: "approved identity",
	avatarPolicy: {
		worldId: "world",
		applyMode: "automatic" as const,
		whilePinned: "candidate" as const,
		schedule: { kind: "wall" as const, epochMs: 0 },
		eventFamilyIds: [],
	},
	referenceLimits: { maxAssets: 2, maxTotalBytes: 2000 },
	maxHistoryRecords: 200,
};
const asset: AvatarAsset = {
	sha256: "a".repeat(64),
	mime: "image/png",
	size: 100,
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-visual-repair1-"));
	path = join(dir, "agents.sqlite");
	store = new AgentStore(path);
	store.create(profile);
	store.updateVisual("lina", 1, settings);
	store.putVisualGrant("lina", 2, {
		version: 1,
		id: "text",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(settings),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" }],
		revoked: false,
	});
	store.syncAvatarInventory([{ fileId: "a.png", ...asset }]);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});
function reopen() {
	store.close();
	store = new AgentStore(path);
}
function admission(intentId = "intent"): AvatarAdmission {
	const f = store.freezeVisualIdentity("lina", { kind: "avatar" });
	return {
		agentId: "lina",
		worldId: "world",
		intentId,
		materialDigest: "d".repeat(64),
		resolvedPolicyId: "policy",
		profileRevision: f.profileRevision,
		visualRevision: f.visualRevision,
		avatarPolicyRevision: f.avatarPolicyRevision,
		source: {
			kind: "avatar_wall",
			scheduleKey: "e".repeat(64),
			slotIndex: 0,
			dueAtMs: 0,
			resolvedPolicyId: "policy",
		},
		grants: f.grants,
	};
}
function candidate(): GeneratedAvatarCandidate {
	const a = admission();
	store.admitAvatarIntent("lina", a);
	return store.recordAvatarCandidate({
		...a,
		version: 1,
		kind: "generated",
		candidateId: "candidate",
		attemptId: "attempt",
		providerGenerationId: "00000000-0000-4000-8000-000000000001",
		artifact: { id: "00000000-0000-4000-8000-000000000001", ...asset },
		avatar: asset,
	});
}
function manual(requestKey: string, source: ManualAvatarInput["source"]) {
	return store.applyManualAvatarOnce(
		"lina",
		{
			requestKey,
			expectedProfileRevision: requireVisualRecord(store.get("lina")).revision,
			expectedVisualRevision: store.visual("lina").revision,
			source,
			asset,
		},
		() => true,
	);
}
function corrupt(sql: string) {
	store.close();
	const db = new DatabaseSync(path);
	db.exec(sql);
	db.close();
}
function rejectsReopen(pattern: RegExp) {
	expect(() => {
		const reopened = new AgentStore(path);
		reopened.close();
	}).toThrow(pattern);
}

test("R1 grant effective at frozen visual revision rejects revoke then reauthorize laundering on disk reopen", () => {
	const initial = store.freezeVisualIdentity("lina", { kind: "avatar" }),
		grant = requireVisualRecord(store.visualGrantAt("lina", "text", 1));
	store.putVisualGrant("lina", 3, { ...grant, revision: 2, revoked: true });
	const forged = { ...initial, visualRevision: 4 };
	reopen();
	expect(() => store.validateFrozenVisualIdentity(forged)).toThrow(
		/historical/,
	);
	store.putVisualGrant("lina", 4, { ...grant, revision: 3 });
	reopen();
	expect(store.visualIdentityAllowed(forged, "provider")).toBe(false);
	expect(() => store.validateFrozenVisualIdentity(initial)).not.toThrow();
	expect(() =>
		store.validateFrozenVisualIdentity(
			store.freezeVisualIdentity("lina", { kind: "avatar" }),
		),
	).not.toThrow();
});
test("R2 nonexistent future profile revision is rejected by historical and current validation after reopen", () => {
	const frozen = store.freezeVisualIdentity("lina", { kind: "avatar" });
	reopen();
	const forged = { ...frozen, profileRevision: 999999 };
	expect(() => store.validateFrozenVisualIdentity(forged)).toThrow(
		/historical|profile/,
	);
	expect(store.visualIdentityAllowed(forged, "provider")).toBe(false);
});
test("R2 an actual profile revision created after the selected visual snapshot ended cannot be reassociated", () => {
	const frozen = store.freezeVisualIdentity("lina", { kind: "avatar" });
	store.setAvatarPinned("lina", {
		requestKey: "pin",
		expectedRevision: 3,
		pinned: true,
	});
	store.update("lina", 1, { personality: "new authored identity" });
	reopen();
	expect(() =>
		store.validateFrozenVisualIdentity({ ...frozen, profileRevision: 2 }),
	).toThrow(/historical|profile/);
	expect(() => store.validateFrozenVisualIdentity(frozen)).not.toThrow();
});
test("R2 valid nonvisual profile edits share the unchanged visual snapshot across reopen", () => {
	const before = store.freezeVisualIdentity("lina", { kind: "avatar" });
	store.update("lina", 1, { voice: "soft" });
	const after = store.freezeVisualIdentity("lina", { kind: "avatar" });
	expect(after.visualRevision).toBe(before.visualRevision);
	expect(after.profileRevision).toBe(2);
	store.setAvatarPinned("lina", {
		requestKey: "pin",
		expectedRevision: 3,
		pinned: true,
	});
	reopen();
	expect(() => store.validateFrozenVisualIdentity(before)).not.toThrow();
	expect(() => store.validateFrozenVisualIdentity(after)).not.toThrow();
});
test("R3 released candidate and physical reservation rows keep consuming explicit history capacity across reopen", () => {
	store.updateVisual("lina", 3, { ...settings, maxHistoryRecords: 14 });
	store.admitAvatarIntent("lina", admission());
	let held = false,
		accepted = 0;
	for (let i = 0; i < 30; i++) {
		try {
			store.reserveAvatarCapacity({
				reservationId: `capacity-${i}`,
				owner: {
					kind: "generated",
					agentId: "lina",
					worldId: "world",
					intentId: "intent",
					attemptId: `attempt-${i}`,
				},
				maxBytes: 100,
			});
		} catch (error) {
			expect(String(error)).toMatch(/history capacity/);
			held = true;
			break;
		}
		accepted++;
		store.releaseAvatarCapacity(`capacity-${i}`);
		reopen();
	}
	expect(held).toBe(true);
	expect(accepted).toBeGreaterThan(0);
	const db = new DatabaseSync(path);
	const rows = db
		.prepare(
			"SELECT COUNT(*) n FROM agent_avatar_capacity_reservations WHERE state='released'",
		)
		.get();
	expect(rows?.["n"]).toBe(accepted);
	expect(
		db
			.prepare(
				"SELECT COUNT(*) n FROM agent_avatar_candidate_reservations WHERE state='released'",
			)
			.get()?.["n"],
	).toBe(accepted);
	db.close();
});
for (const mode of ["generated", "manual"] as const)
	test(`R4 ${mode} application binds the full returned profile to an immutable owned version`, () => {
		if (mode === "generated") {
			const c = candidate();
			store.applyAvatarOnce(
				"lina",
				{
					requestKey: "apply",
					candidateId: c.candidateId,
					expectedProfileRevision: 1,
					expectedVisualRevision: 3,
					mode: "manual",
				},
				{ kind: "owner", validateCandidate: () => true },
			);
		} else manual("apply", { kind: "upload" });
		// Advance the real profile so comparing the receipt against only current state is insufficient.
		store.update("lina", 2, { personality: "later identity" });
		reopen();
		corrupt(
			"UPDATE agent_avatar_receipts SET outcome_json=json_set(outcome_json,'$.profile.personality','DIFFERENT IDENTITY') WHERE request_key='apply'",
		);
		rejectsReopen(/profile|receipt/);
	});
test("R5 missing root of a multi-hop manual restoration ancestry rejects real reopen", () => {
	const root = store.registerSeedAvatar("lina", asset, "seed", () => true),
		first = manual("restore-one", { kind: "restore", authorityId: root.id });
	manual("restore-two", { kind: "restore", authorityId: first.authorityId });
	reopen();
	store.close();
	const db = new DatabaseSync(path);
	db.prepare("DELETE FROM agent_avatar_authorities WHERE id=?").run(root.id);
	db.close();
	rejectsReopen(/ancestry|authority/);
});
test("R5 historical restore lineage survives parent revocation while a fresh restore still requires current permission", () => {
	const root = store.registerSeedAvatar("lina", asset, "seed", () => true);
	const first = manual("restore-one", {
		kind: "restore",
		authorityId: root.id,
	});
	store.revokeAvatarAuthority("lina", root.id);
	reopen();
	expect(store.avatarAuthorities(asset.sha256).map((a) => a.id)).toContain(
		first.authorityId,
	);
	expect(() =>
		manual("revoked-parent", { kind: "restore", authorityId: root.id }),
	).toThrow(/authority/);
});
for (const change of ["owner", "asset", "kind", "cycle"] as const)
	test(`R5 restore ancestry rejects a ${change} mismatch even with a valid metadata digest`, () => {
		if (change === "owner")
			store.create({ ...profile, id: "other", name: "Other" });
		const root = store.registerSeedAvatar("lina", asset, "seed", () => true),
			first = manual("restore", { kind: "restore", authorityId: root.id });
		reopen();
		store.close();
		const db = new DatabaseSync(path);
		const id = change === "cycle" ? first.authorityId : root.id;
		const row = requireVisualRecord(
			db
				.prepare("SELECT data FROM agent_avatar_authorities WHERE id=?")
				.get(id),
		);
		const value = JSON.parse(String(row["data"]));
		if (change === "owner") value.agentId = "other";
		if (change === "asset") value.asset.size = 99;
		if (change === "kind") value.kind = "generated";
		if (change === "cycle")
			value.source = { kind: "restore", authorityId: first.authorityId };
		db.prepare(
			"UPDATE agent_avatar_authorities SET agent_id=?,data=?,digest=? WHERE id=?",
		).run(value.agentId, JSON.stringify(value), visualDigest(value), id);
		if (change === "cycle") {
			const r = requireVisualRecord(
				db
					.prepare(
						"SELECT input_json,outcome_json FROM agent_avatar_receipts WHERE request_key='restore'",
					)
					.get(),
			);
			const input = JSON.parse(String(r["input_json"])),
				outcome = JSON.parse(String(r["outcome_json"]));
			input.source = value.source;
			outcome.payloadDigest = visualDigest(input);
			db.prepare(
				"UPDATE agent_avatar_receipts SET input_json=?,payload_digest=?,outcome_json=? WHERE request_key='restore'",
			).run(
				JSON.stringify(input),
				visualDigest(input),
				JSON.stringify(outcome),
			);
		}
		db.close();
		rejectsReopen(/authority|ancestry|avatar|candidate|foreign|visual/);
	});
test("R6 a candidate without its filled reservation rejects disk reopen", () => {
	candidate();
	reopen();
	corrupt("DELETE FROM agent_avatar_candidate_reservations");
	rejectsReopen(/candidate.*(capacity|reservation)|capacity.*candidate/);
});

test("R3 repeated physical reservation IDs for an existing filled attempt still consume metadata capacity", () => {
	candidate();
	store.updateVisual("lina", 3, { ...settings, maxHistoryRecords: 14 });
	const reserve = (reservationId: string) =>
		store.reserveAvatarCapacity({
			reservationId,
			owner: {
				kind: "generated",
				agentId: "lina",
				worldId: "world",
				intentId: "intent",
				attemptId: "attempt",
			},
			maxBytes: 100,
		});
	reserve("first");
	store.releaseAvatarCapacity("first");
	reopen();
	expect(() => reserve("second")).toThrow(/history capacity/);
	expect(store.avatarCapacityReservation("first")?.state).toBe("released");
	expect(store.avatarCapacityReservation("second")).toBeUndefined();
	expect(store.avatarHistory("lina")).toHaveLength(1);
});
test("R3 generated physical metadata requires explicit history budget, while manual upload remains independent", () => {
	store.updateVisual("lina", 3, { ...settings, maxHistoryRecords: null });
	expect(() =>
		store.reserveAvatarCapacity({
			reservationId: "generated",
			owner: {
				kind: "generated",
				agentId: "lina",
				worldId: "world",
				intentId: "intent",
				attemptId: "attempt",
			},
			maxBytes: 100,
		}),
	).toThrow(/history limits/);
	expect(
		store.reserveAvatarCapacity({
			reservationId: "manual",
			owner: { kind: "manual", agentId: "lina", requestKey: "upload" },
			maxBytes: 100,
		}).state,
	).toBe("reserved");
	reopen();
	expect(store.avatarCapacityReservation("generated")).toBeUndefined();
});
test("R6 candidate reads reject a missing reservation before an already-open owner can qualify it", () => {
	const c = candidate();
	const db = new DatabaseSync(path);
	db.exec("DELETE FROM agent_avatar_candidate_reservations");
	db.close();
	expect(() => store.avatarCandidateAllowed(c, "destination")).toThrow(
		/candidate capacity reservation/,
	);
});
