import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "./types.ts";
import { boundedId, validateAgentInput } from "./validation.ts";
import type {
	AvatarApplicationReceipt,
	ManualAvatarReceipt,
} from "./visual.ts";
import type { VisualApplications } from "./visual-applications.ts";
import type { VisualCapacity } from "./visual-capacity.ts";
import type { VisualPersistence } from "./visual-persistence.ts";
import {
	bool,
	exact,
	hash,
	integer,
	parseAgentVisual,
	parseAvatarApply,
	parseAvatarAsset,
	requireVisualRecord,
	visualDigest,
	visualIdentityDigest,
} from "./visual-validation.ts";

export function auditVisuals(
	db: DatabaseSync,
	visuals: VisualPersistence,
	applications: VisualApplications,
	capacity: VisualCapacity,
	profiles: AgentProfile[],
): void {
	visuals.profiles.audit(profiles, (id, revision) => visuals.at(id, revision));
	for (const p of profiles) {
		const current = visuals.get(p.id),
			history = visuals.history(p.id);
		if (!history.length || !isDeepStrictEqual(history.at(-1), current))
			throw Error("invalid current visual history fence");
		for (const [i, v] of history.entries()) {
			const previous = history[i - 1];
			if (
				v.revision !== i + 1 ||
				!visuals.profiles.associated(v, v.profileRevision) ||
				(previous && v.profileRevision < previous.profileRevision)
			)
				throw Error("invalid visual history chain");
			const policyRevision =
				(previous?.avatarPolicyRevision ?? 0) +
				(previous && !isDeepStrictEqual(previous.avatarPolicy, v.avatarPolicy)
					? 1
					: 0);
			if (
				v.avatarPolicyRevision !== policyRevision ||
				(!previous && (v.avatarPolicy !== null || v.pinned))
			)
				throw Error("invalid avatar policy history chain");
			if (
				v.canonicalReferenceId &&
				!visuals.identity.reference(p.id, v.canonicalReferenceId)
			)
				throw Error("missing historical visual reference");
		}
		visuals.identity.references(p.id);
		for (const grant of visuals.identity.grants(p.id)) {
			const rows = db
				.prepare(
					"SELECT revision FROM agent_visual_grant_history WHERE agent_id=? AND id=? ORDER BY revision",
				)
				.all(p.id, grant.id);
			for (const [i, r] of rows.entries()) {
				const g = visuals.identity.grantAt(
					p.id,
					grant.id,
					Number(r["revision"]),
				);
				const grantedAt = visuals.at(
					p.id,
					visuals.identity.grantVisualRevision(p.id, grant.id, i + 1),
				);
				if (!grantedAt) throw Error("missing original grant visual fence");
				if (
					i > 0 &&
					visuals.identity.grantVisualRevision(p.id, grant.id, i) >=
						grantedAt.revision
				)
					throw Error("invalid visual grant effective order");
				if (
					!g ||
					g.revision !== i + 1 ||
					!isDeepStrictEqual(g.subject, grant.subject)
				)
					throw Error("invalid immutable visual grant subject/history");
				if (g.subject.kind === "reference") {
					if (
						visuals.identity.reference(p.id, g.subject.referenceId)?.sha256 !==
						g.subject.sha256
					)
						throw Error("invalid historical reference subject");
				} else {
					const digest = g.subject.identityDigest;
					if (
						!history.some(
							(v) => v.textIdentity && visualIdentityDigest(v) === digest,
						)
					)
						throw Error("invalid historical text subject");
				}
			}
			if (
				!isDeepStrictEqual(
					visuals.identity.grantAt(p.id, grant.id, rows.length),
					grant,
				)
			)
				throw Error("invalid current visual grant fence");
		}
		const admissions = db
			.prepare(
				"SELECT intent_id,ordinal FROM agent_avatar_admissions WHERE agent_id=? ORDER BY ordinal",
			)
			.all(p.id);
		for (const [i, r] of admissions.entries()) {
			if (r["ordinal"] !== i + 1) throw Error("invalid avatar admission order");
			visuals.assertAdmission(
				requireVisualRecord(visuals.admission(p.id, String(r["intent_id"]))),
			);
		}
		for (const c of visuals.candidates(p.id)) {
			const {
				version: _v,
				kind: _k,
				candidateId: _c,
				attemptId: _a,
				providerGenerationId: _p,
				artifact: _ar,
				avatar: _av,
				...a
			} = c;
			if (!isDeepStrictEqual(visuals.admission(p.id, c.intentId), a))
				throw Error("invalid avatar candidate lineage");
		}
	}
	// History must have a recognized current owner, including a grant with no current row.
	for (const r of db
		.prepare(
			"SELECT agent_id,id FROM agent_visual_grant_history GROUP BY agent_id,id",
		)
		.iterate())
		if (!visuals.identity.grant(String(r["agent_id"]), String(r["id"])))
			throw Error("orphan visual grant history");
	capacity.audit();
	for (const r of db
		.prepare(
			"SELECT agent_id,intent_id,attempt_id,state FROM agent_avatar_candidate_reservations",
		)
		.iterate()) {
		if (!["reserved", "filled", "released"].includes(String(r["state"])))
			throw Error("invalid candidate capacity state");
		const candidate = db
			.prepare(
				"SELECT 1 FROM agent_avatar_history WHERE agent_id=? AND intent_id=? AND attempt_id=?",
			)
			.get(
				String(r["agent_id"]),
				String(r["intent_id"]),
				String(r["attempt_id"]),
			);
		if ((r["state"] === "filled") !== Boolean(candidate))
			throw Error("invalid candidate capacity settlement");
	}
	for (const r of db
		.prepare(
			"SELECT agent_id,sha256,source_json FROM agent_avatar_legacy_sources",
		)
		.iterate()) {
		hash(r["sha256"]);
		const raw = JSON.parse(String(r["source_json"]));
		if (raw?.kind === "profile") {
			const s = exact(raw, "kind,profileRevision");
			const v = visuals.at(String(r["agent_id"]), 1);
			if (!v || integer(s["profileRevision"], 1) !== v.profileRevision)
				throw Error("invalid captured legacy revision");
		} else {
			const s = exact(raw, "kind,sourceId");
			if (s["kind"] !== "seed") throw Error("invalid legacy avatar source");
			boundedId(s["sourceId"], "seed source");
		}
	}
	auditReceipts(db, visuals, applications);
	for (const r of db
		.prepare("SELECT id FROM agent_avatar_authorities")
		.iterate()) {
		const a = requireVisualRecord(applications.authority(String(r["id"])));
		hash(a.sha256);
		if (a.version !== 1) throw Error("invalid avatar authority version");
		if (a.kind === "generated") {
			exact(a, "version,id,agentId,sha256,kind,requestKey,candidate");
			if (
				!isDeepStrictEqual(
					visuals.candidate(a.agentId, a.candidate.candidateId),
					a.candidate,
				) ||
				a.candidate.avatar.sha256 !== a.sha256
			)
				throw Error("invalid generated avatar authority lineage");
			const receipt = db
				.prepare(
					"SELECT kind,outcome_json FROM agent_avatar_receipts WHERE agent_id=? AND request_key=?",
				)
				.get(a.agentId, a.requestKey);
			if (
				receipt?.["kind"] !== "generated" ||
				JSON.parse(String(receipt["outcome_json"])).candidateId !==
					a.candidate.candidateId
			)
				throw Error("orphan generated avatar authority");
		} else if (a.kind === "manual") {
			applications.assertManualAncestry(a);
			exact(a, "version,id,agentId,sha256,kind,requestKey,source,asset");
			parseAvatarAsset(a.asset);
			const r = db
				.prepare(
					"SELECT kind,input_json,outcome_json FROM agent_avatar_receipts WHERE agent_id=? AND request_key=?",
				)
				.get(a.agentId, a.requestKey);
			if (
				r?.["kind"] !== "manual" ||
				JSON.parse(String(r["outcome_json"])).authorityId !== a.id ||
				!isDeepStrictEqual(JSON.parse(String(r["input_json"])).source, a.source)
			)
				throw Error("orphan manual avatar authority");
		} else if (a.kind === "legacy") {
			exact(a, "version,id,agentId,sha256,kind,source,asset");
			parseAvatarAsset(a.asset);
			const r = db
				.prepare(
					"SELECT source_json FROM agent_avatar_legacy_sources WHERE agent_id=? AND sha256=?",
				)
				.get(a.agentId, a.sha256);
			if (
				!r ||
				!isDeepStrictEqual(JSON.parse(String(r["source_json"])), a.source)
			)
				throw Error("orphan legacy avatar authority");
		} else throw Error("invalid avatar authority kind");
		if (a.kind !== "generated" && a.asset.sha256 !== a.sha256)
			throw Error("avatar authority hash conflict");
		if (!capacity.has(a.kind === "generated" ? a.candidate.avatar : a.asset))
			throw Error("avatar authority missing retained capacity");
	}
}
function auditReceipts(
	db: DatabaseSync,
	visuals: VisualPersistence,
	applications: VisualApplications,
): void {
	for (const r of db
		.prepare(
			"SELECT agent_id,request_key,kind,payload_digest,input_json,outcome_json FROM agent_avatar_receipts",
		)
		.iterate()) {
		const id = String(r["agent_id"]),
			key = String(r["request_key"]),
			input = JSON.parse(String(r["input_json"])),
			outcome = JSON.parse(String(r["outcome_json"]));
		if (visualDigest(input) !== r["payload_digest"] || input.requestKey !== key)
			throw Error("corrupt avatar receipt digest");
		if (r["kind"] === "pin") {
			const p = exact(input, "requestKey,expectedRevision,pinned");
			integer(p["expectedRevision"], 1);
			bool(p["pinned"]);
			const v = parseAgentVisual(outcome);
			if (
				v.agentId !== id ||
				v.pinned !== p["pinned"] ||
				!isDeepStrictEqual(visuals.at(id, v.revision), v) ||
				![
					Number(p["expectedRevision"]),
					Number(p["expectedRevision"]) + 1,
				].includes(v.revision)
			)
				throw Error("invalid pin receipt");
			continue;
		}
		let receipt: AvatarApplicationReceipt | ManualAvatarReceipt;
		if (r["kind"] === "generated") {
			const request = parseAvatarApply(input);
			exact(
				outcome,
				"version,agentId,requestKey,payloadDigest,candidateId,mode,avatarId,profile,visual",
			);
			receipt = outcome as AvatarApplicationReceipt;
			const c = visuals.candidate(id, request.candidateId);
			if (
				!c ||
				receipt.candidateId !== c.candidateId ||
				receipt.mode !== request.mode ||
				receipt.avatarId !== c.avatar.sha256 ||
				receipt.profile.avatarId !== c.avatar.sha256
			)
				throw Error("invalid avatar application receipt");
			const a = applications.authority(
				visualDigest({ agentId: id, requestKey: key }),
			);
			if (a?.kind !== "generated" || a.requestKey !== key)
				throw Error("missing avatar application authority");
		} else if (r["kind"] === "manual") {
			exact(
				input,
				"requestKey,expectedProfileRevision,expectedVisualRevision,asset,source",
			);
			exact(
				outcome,
				"version,agentId,requestKey,payloadDigest,authorityId,profile,visual",
			);
			parseAvatarAsset(input.asset);
			if (input.source?.kind === "upload") exact(input.source, "kind");
			else {
				exact(input.source, "kind,authorityId");
				if (input.source.kind !== "restore")
					throw Error("invalid manual receipt source");
			}
			receipt = outcome as ManualAvatarReceipt;
			if (
				receipt.profile.avatarId !== input.asset.sha256 ||
				applications.authority(receipt.authorityId)?.kind !== "manual"
			)
				throw Error("invalid manual avatar receipt");
		} else throw Error("invalid avatar receipt kind");
		const { revision, ...profile } = receipt.profile;
		validateAgentInput(profile);
		const visual = parseAgentVisual(receipt.visual);
		visuals.profiles.assertOutcome(receipt.profile, visual.revision);
		if (
			receipt.version !== 1 ||
			receipt.agentId !== id ||
			receipt.requestKey !== key ||
			receipt.payloadDigest !== r["payload_digest"] ||
			receipt.profile.id !== id ||
			visual.agentId !== id ||
			revision !== integer(input.expectedProfileRevision, 1) + 1 ||
			visual.revision !== integer(input.expectedVisualRevision, 1) + 1 ||
			visual.profileRevision !== revision ||
			!isDeepStrictEqual(visuals.at(id, visual.revision), visual)
		)
			throw Error("invalid avatar receipt outcome");
	}
}
