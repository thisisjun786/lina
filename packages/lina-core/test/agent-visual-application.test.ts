import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import type {
	AvatarAdmission,
	AvatarApplyInput,
	GeneratedAvatarCandidate,
} from "../src/agents/visual.ts";
import {
	avatarAutomaticRequestKey,
	requireVisualRecord,
	visualIdentityDigest,
} from "../src/agents/visual-validation.ts";

let dir: string, store: AgentStore;
const owner = { kind: "owner" as const, validateCandidate: () => true };
const automatic = { kind: "automatic" as const, validateCandidate: () => true };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-avatar-apply-"));
	store = new AgentStore(join(dir, "agents.sqlite"), () => 100);
	store.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "private lore",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const input = {
		anchors: ["silver eyes"],
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
	store.updateVisual("lina", 1, input);
	store.putVisualGrant("lina", 2, {
		version: 1,
		id: "text",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(input),
		},
		providerUse: true,
		purposes: [{ kind: "avatar" }],
		revoked: false,
	});
	store.syncAvatarInventory([]);
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});
function candidate(intentId: string, letter: string): GeneratedAvatarCandidate {
	const v = store.visual("lina"),
		f = store.freezeVisualIdentity("lina", { kind: "avatar" });
	const admission: AvatarAdmission = {
		agentId: "lina",
		worldId: "world",
		intentId,
		materialDigest: "d".repeat(64),
		resolvedPolicyId: "policy",
		profileRevision: requireVisualRecord(store.get("lina")).revision,
		visualRevision: v.revision,
		avatarPolicyRevision: v.avatarPolicyRevision,
		source: {
			kind: "avatar_wall",
			scheduleKey: "e".repeat(64),
			slotIndex: store.avatarHistory("lina").length,
			dueAtMs: 100,
			resolvedPolicyId: "policy",
		},
		grants: f.grants,
	};
	store.admitAvatarIntent("lina", admission);
	const c: GeneratedAvatarCandidate = {
		...admission,
		version: 1,
		kind: "generated",
		candidateId: `candidate-${intentId}`,
		attemptId: "attempt",
		providerGenerationId: `00000000-0000-4000-8000-${letter.repeat(12)}`,
		artifact: {
			id: `00000000-0000-4000-8000-${letter.repeat(12)}`,
			sha256: letter.repeat(64),
			mime: "image/png",
			size: 100,
		},
		avatar: { sha256: letter.repeat(64), mime: "image/png", size: 100 },
	};
	store.recordAvatarCandidate(c);
	store.reserveAvatarCapacity({
		reservationId: intentId,
		owner: {
			kind: "generated",
			agentId: "lina",
			worldId: "world",
			intentId,
			attemptId: "attempt",
		},
		maxBytes: 200,
	});
	store.settleAvatarCapacity(intentId, {
		fileId: `${letter}.png`,
		...c.avatar,
	});
	return c;
}
function input(
	c: GeneratedAvatarCandidate,
	key: string,
	mode: AvatarApplyInput["mode"] = "restore",
): AvatarApplyInput {
	return {
		requestKey: mode === "automatic" ? avatarAutomaticRequestKey(c) : key,
		candidateId: c.candidateId,
		expectedProfileRevision: requireVisualRecord(store.get("lina")).revision,
		expectedVisualRevision: store.visual("lina").revision,
		mode,
	};
}
test("A B A restoration is a new operation; old receipt replay returns history without reapplying", () => {
	store.applyReflection(
		"lina",
		{
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "learn",
			sourceEntryIds: ["entry"],
			interests: ["jazz"],
		},
		() => true,
	);
	const dynamics = store.dynamics("lina");
	const a = candidate("a", "a"),
		ia = input(a, "apply-a", "automatic");
	const ra = store.applyAvatarOnce("lina", ia, automatic);
	const b = candidate("b", "b");
	store.applyAvatarOnce("lina", input(b, "apply-b", "automatic"), automatic);
	expect(store.get("lina")?.avatarId).toBe("b".repeat(64));
	for (const [c, k] of [
		[a, "restore-a-1"],
		[b, "restore-b-1"],
		[a, "restore-a-2"],
	] as const) {
		const request = input(c, k);
		const receipt = store.applyAvatarOnce("lina", request, owner);
		store.close();
		store = new AgentStore(join(dir, "agents.sqlite"), () => 100);
		expect(store.get("lina")?.avatarId).toBe(c.avatar.sha256);
		expect(store.applyAvatarOnce("lina", request, owner)).toEqual(receipt);
	}
	const revision = requireVisualRecord(store.get("lina")).revision;
	expect(store.applyAvatarOnce("lina", ia, automatic)).toEqual(ra);
	expect(store.get("lina")?.revision).toBe(revision);
	expect(store.get("lina")?.avatarId).toBe(a.avatar.sha256);
	expect(store.applyAvatarOnce("lina", ia, automatic)).toEqual(ra);
	expect(() =>
		store.applyAvatarOnce("lina", { ...ia, candidateId: b.candidateId }, owner),
	).toThrow(/conflict/);
	expect(store.dynamics("lina")).toEqual(dynamics);
	expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
	expect(store.avatarHistory("lina")).toHaveLength(2);
	expect(store.visual("lina").avatarPolicyRevision).toBe(1);
});
test("latest admitted intent is independent of visual revision and fences old automatic candidates", () => {
	const a = candidate("a", "a");
	const v = store.visual("lina");
	const b = candidate("b", "b");
	expect(store.visual("lina")).toEqual(v);
	expect(() =>
		store.applyAvatarOnce("lina", input(a, "old", "automatic"), automatic),
	).toThrow(/latest/);
	store.setAvatarPinned("lina", {
		requestKey: "pin",
		expectedRevision: v.revision,
		pinned: true,
	});
	expect(() =>
		store.applyAvatarOnce("lina", input(b, "pin-auto", "automatic"), automatic),
	).toThrow(/pinned|stale/);
	expect(() =>
		store.applyAvatarOnce("lina", input(a, "forged-owner"), automatic),
	).toThrow(/authority/);
	store.applyAvatarOnce("lina", input(a, "manual-old"), owner);
	expect(store.get("lina")?.avatarId).toBe(a.avatar.sha256);
	expect(store.visual("lina").avatarPolicyRevision).toBe(1);
});
test("candidate and publication authority preserve full lineage; provider revoke differs from destination revoke", () => {
	const c = candidate("a", "a");
	expect(store.avatarAuthorities(c.avatar.sha256)).toEqual([]);
	store.applyAvatarOnce("lina", input(c, "apply"), owner);
	const grant = requireVisualRecord(store.visualGrantAt("lina", "text", 1));
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		revision: 2,
		providerUse: false,
	});
	const authorities = store.avatarAuthorities(c.avatar.sha256);
	expect(authorities).toHaveLength(1);
	expect(authorities[0]).toMatchObject({ kind: "generated", candidate: c });
	expect(store.avatarCandidateAllowed(c, "destination")).toBe(true);
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		revision: 3,
		purposes: [],
	});
	expect(store.avatarCandidateAllowed(c, "destination")).toBe(false);
	expect(() =>
		store.applyAvatarOnce("lina", input(c, "revoked"), owner),
	).toThrow(/permission/);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.avatarHistory("lina")).toEqual([c]);
	expect(store.avatarAuthorities(c.avatar.sha256)).toHaveLength(1);
});
test("candidate identity conflicts and trusted current owner validation fail closed", () => {
	const c = candidate("a", "a");
	expect(store.recordAvatarCandidate(c)).toEqual(c);
	expect(() =>
		store.recordAvatarCandidate({ ...c, candidateId: "other" }),
	).toThrow(/conflict/);
	expect(() =>
		store.recordAvatarCandidate({ ...c, materialDigest: "f".repeat(64) }),
	).toThrow(/conflict/);
	expect(() =>
		store.applyAvatarOnce("lina", input(c, "denied"), {
			kind: "owner",
			validateCandidate: () => false,
		}),
	).toThrow(/authority/);
	expect(store.get("lina")?.avatarId).toBeNull();
});

test("candidate admission reserves history before generation; disabled budgets cannot discard a completed result", () => {
	const v = store.visual("lina"),
		f = store.freezeVisualIdentity("lina", { kind: "avatar" });
	const a: AvatarAdmission = {
		agentId: "lina",
		worldId: "world",
		intentId: "reserved",
		materialDigest: "d".repeat(64),
		resolvedPolicyId: "policy",
		profileRevision: 1,
		visualRevision: v.revision,
		avatarPolicyRevision: v.avatarPolicyRevision,
		source: {
			kind: "avatar_wall",
			scheduleKey: "e".repeat(64),
			slotIndex: 0,
			dueAtMs: 100,
			resolvedPolicyId: "policy",
		},
		grants: f.grants,
	};
	store.admitAvatarIntent("lina", a);
	store.reserveAvatarCandidate("lina", a.intentId, "attempt");
	const {
		version: _v,
		agentId: _a,
		revision: _r,
		profileRevision: _p,
		avatarPolicyRevision: _ap,
		pinned: _pin,
		...settings
	} = store.visual("lina");
	store.updateVisual("lina", v.revision, {
		...settings,
		maxHistoryRecords: 0,
		referenceLimits: null,
	});
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	const c: GeneratedAvatarCandidate = {
		...a,
		version: 1,
		kind: "generated",
		candidateId: "reserved",
		attemptId: "attempt",
		providerGenerationId: "00000000-0000-4000-8000-000000000001",
		artifact: {
			id: "00000000-0000-4000-8000-000000000001",
			sha256: "a".repeat(64),
			mime: "image/png",
			size: 100,
		},
		avatar: { sha256: "a".repeat(64), mime: "image/png", size: 100 },
	};
	expect(store.recordAvatarCandidate(c)).toEqual(c);
	expect(() =>
		store.reserveAvatarCandidate("lina", a.intentId, "new-attempt"),
	).toThrow(/history|reference/);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(store.avatarHistory("lina")).toEqual([c]);
});

test("automatic operation key is deterministically bound to the original candidate attempt", () => {
	const c = candidate("a", "a");
	expect(() =>
		store.applyAvatarOnce(
			"lina",
			{
				...input(c, "arbitrary-key", "automatic"),
				requestKey: "arbitrary-key",
			},
			automatic,
		),
	).toThrow(/operation key/);
});

test("same bytes retain independent generated and manual publication authorities", () => {
	const a = candidate("a", "a");
	store.applyAvatarOnce("lina", input(a, "first"), owner);
	const grant = requireVisualRecord(store.visualGrantAt("lina", "text", 1));
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		id: "independent",
		revision: 1,
	});
	const b = candidate("b", "a");
	store.applyAvatarOnce("lina", input(b, "second"), owner);
	const allowed = () =>
		store
			.avatarAuthorities(a.avatar.sha256)
			.filter(
				(x) =>
					x.kind !== "generated" ||
					store.avatarCandidateAllowed(x.candidate, "destination"),
			);
	expect(allowed()).toHaveLength(2);
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		revision: 2,
		purposes: [],
	});
	expect(allowed()).toHaveLength(1);
	store.putVisualGrant("lina", store.visual("lina").revision, {
		...grant,
		id: "independent",
		revision: 2,
		purposes: [],
	});
	expect(allowed()).toHaveLength(0);
	store.applyManualAvatarOnce(
		"lina",
		{
			requestKey: "manual-independent",
			expectedProfileRevision: requireVisualRecord(store.get("lina")).revision,
			expectedVisualRevision: store.visual("lina").revision,
			asset: a.avatar,
			source: { kind: "upload" },
		},
		() => true,
	);
	expect(allowed()).toHaveLength(1);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(allowed()).toHaveLength(1);
});

test("historic receipt replay while another hash is current never reapplies old bytes", () => {
	const a = candidate("a", "a"),
		request = input(a, "first"),
		receipt = store.applyAvatarOnce("lina", request, owner);
	const b = candidate("b", "b");
	store.applyAvatarOnce("lina", input(b, "second"), owner);
	store.close();
	store = new AgentStore(join(dir, "agents.sqlite"));
	expect(
		store.applyAvatarOnce("lina", request, {
			kind: "owner",
			validateCandidate: () => false,
		}),
	).toEqual(receipt);
	expect(store.get("lina")?.avatarId).toBe(b.avatar.sha256);
});

test("automatic application and publication metadata cannot escape the explicit history bound", () => {
	const {
		version: _v,
		agentId: _a,
		revision: _r,
		profileRevision: _p,
		avatarPolicyRevision: _ap,
		pinned: _pin,
		...settings
	} = store.visual("lina");
	// Three visual snapshots and one grant history exist. The edit adds one snapshot.
	store.updateVisual("lina", 3, { ...settings, maxHistoryRecords: 7 });
	const v = store.visual("lina"),
		f = store.freezeVisualIdentity("lina", { kind: "avatar" });
	const a: AvatarAdmission = {
		agentId: "lina",
		worldId: "world",
		intentId: "bounded",
		materialDigest: "d".repeat(64),
		resolvedPolicyId: "policy",
		profileRevision: 1,
		visualRevision: v.revision,
		avatarPolicyRevision: 1,
		source: {
			kind: "avatar_wall",
			scheduleKey: "e".repeat(64),
			slotIndex: 0,
			dueAtMs: 100,
			resolvedPolicyId: "policy",
		},
		grants: f.grants,
	};
	// Admission + candidate + automatic visual/application/authority records require more than two free rows.
	expect(() => store.admitAvatarIntent("lina", a)).toThrow(/history capacity/);
	expect(store.latestAvatarIntent("lina")).toBeNull();
});

test("reopen rejects a changed application outcome and preserves the persisted rows", () => {
	const c = candidate("a", "a");
	store.applyAvatarOnce("lina", input(c, "apply"), owner);
	store.close();
	const db = new DatabaseSync(join(dir, "agents.sqlite"));
	db.exec(
		"UPDATE agent_avatar_receipts SET outcome_json=json_set(outcome_json,'$.profile.avatarId','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') WHERE kind='generated'",
	);
	const rows = db.prepare("SELECT * FROM agent_avatar_receipts").all();
	db.close();
	expect(() => new AgentStore(join(dir, "agents.sqlite"))).toThrow(/receipt/);
	const check = new DatabaseSync(join(dir, "agents.sqlite"));
	expect(check.prepare("SELECT * FROM agent_avatar_receipts").all()).toEqual(
		rows,
	);
	check.close();
});

import { DatabaseSync } from "node:sqlite";
