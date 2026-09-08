import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentVisual,
	FrozenVisualIdentity,
	VisualGrant,
	VisualGrantRef,
	VisualPurpose,
	VisualReference,
} from "./visual.ts";
import type { VisualPersistence } from "./visual-persistence.ts";
import {
	parseVisualGrant,
	parseVisualPurpose,
	parseVisualReference,
	requireVisualRecord,
	visualDigest,
	visualIdentityDigest,
} from "./visual-validation.ts";
/** Exact reference ownership and immutable grant history within AgentStore transactions. */
export class VisualIdentity {
	constructor(
		private readonly db: DatabaseSync,
		private readonly state: Pick<
			VisualPersistence,
			| "get"
			| "at"
			| "cas"
			| "advance"
			| "requireHistorySpace"
			| "requireProfile"
			| "profiles"
		>,
	) {}
	register(
		id: string,
		profileRevision: number,
		visualRevision: number,
		input: VisualReference,
	): VisualReference {
		const ref = parseVisualReference(input);
		if (ref.agentId !== id) throw Error("visual reference owner conflict");
		const v = this.state.cas(id, visualRevision);
		if (this.state.requireProfile(id).revision !== profileRevision)
			throw Error("stale profile revision");
		const old = this.reference(id, ref.id);
		if (old) {
			if (!isDeepStrictEqual(old, ref))
				throw Error("visual reference conflict");
			return old;
		}
		const limits = v.referenceLimits;
		if (!limits) throw Error("reference limits not configured");
		const refs = this.references(id),
			assets = new Map(refs.map((r) => [r.assetId, r]));
		const existingAsset = assets.get(ref.assetId);
		if (
			existingAsset &&
			(existingAsset.sha256 !== ref.sha256 ||
				existingAsset.size !== ref.size ||
				existingAsset.mime !== ref.mime)
		)
			throw Error("visual reference asset conflict");
		if (
			!existingAsset &&
			(assets.size + 1 > limits.maxAssets ||
				[...assets.values()].reduce((n, r) => n + r.size, 0) + ref.size >
					limits.maxTotalBytes)
		)
			throw Error("reference capacity reached");
		this.state.requireHistorySpace(id, 2);
		this.db
			.prepare("INSERT INTO agent_visual_references VALUES(?,?,?,?)")
			.run(id, ref.id, JSON.stringify(ref), visualDigest(ref));
		this.state.advance(id, profileRevision);
		return ref;
	}
	reference(id: string, referenceId: string): VisualReference | undefined {
		const r = this.db
			.prepare(
				"SELECT data,digest FROM agent_visual_references WHERE agent_id=? AND id=?",
			)
			.get(id, referenceId);
		if (!r) return undefined;
		const ref = parseVisualReference(JSON.parse(String(r["data"])));
		if (
			ref.agentId !== id ||
			ref.id !== referenceId ||
			visualDigest(ref) !== r["digest"]
		)
			throw Error("corrupt visual reference");
		return ref;
	}
	references(id: string): VisualReference[] {
		return this.db
			.prepare(
				"SELECT id FROM agent_visual_references WHERE agent_id=? ORDER BY id",
			)
			.all(id)
			.map((r) => requireVisualRecord(this.reference(id, String(r["id"]))));
	}
	putGrant(
		id: string,
		expectedRevision: number,
		input: VisualGrant,
	): VisualGrant {
		const grant = parseVisualGrant(input);
		if (grant.agentId !== id) throw Error("visual grant owner conflict");
		const v = this.state.cas(id, expectedRevision),
			old = this.grant(id, grant.id);
		if (old && isDeepStrictEqual(old, grant)) return old;
		if (old && !isDeepStrictEqual(old.subject, grant.subject))
			throw Error("visual grant subject is immutable");
		if (grant.revision !== (old?.revision ?? 0) + 1)
			throw Error("stale grant revision");
		this.assertSubject(grant, v);
		// Revocation and owner permission repairs remain possible at an admission ceiling.
		this.db
			.prepare("INSERT INTO agent_visual_grant_history VALUES(?,?,?,?,?,?)")
			.run(
				id,
				grant.id,
				grant.revision,
				v.revision + 1,
				JSON.stringify(grant),
				visualDigest(grant),
			);
		this.db
			.prepare(
				"INSERT INTO agent_visual_grants VALUES(?,?,?,?) ON CONFLICT(agent_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
			)
			.run(id, grant.id, grant.revision, JSON.stringify(grant));
		this.state.advance(id, this.state.requireProfile(id).revision);
		return grant;
	}
	grant(id: string, grantId: string): VisualGrant | undefined {
		const r = this.db
			.prepare(
				"SELECT revision,data FROM agent_visual_grants WHERE agent_id=? AND id=?",
			)
			.get(id, grantId);
		if (!r) return undefined;
		const v = parseVisualGrant(JSON.parse(String(r["data"])));
		if (v.agentId !== id || v.id !== grantId || v.revision !== r["revision"])
			throw Error("corrupt visual grant");
		return v;
	}
	grantVisualRevision(id: string, grantId: string, revision: number): number {
		return Number(
			this.db
				.prepare(
					"SELECT visual_revision FROM agent_visual_grant_history WHERE agent_id=? AND id=? AND revision=?",
				)
				.get(id, grantId, revision)?.["visual_revision"] ??
				Number.MAX_SAFE_INTEGER,
		);
	}
	grantAtVisual(
		id: string,
		grantId: string,
		visualRevision: number,
	): VisualGrant | undefined {
		const row = this.db
			.prepare(
				"SELECT revision FROM agent_visual_grant_history WHERE agent_id=? AND id=? AND visual_revision<=? ORDER BY visual_revision DESC LIMIT 1",
			)
			.get(id, grantId, visualRevision);
		return row ? this.grantAt(id, grantId, Number(row["revision"])) : undefined;
	}
	grantAt(
		id: string,
		grantId: string,
		revision: number,
	): VisualGrant | undefined {
		const r = this.db
			.prepare(
				"SELECT data,digest FROM agent_visual_grant_history WHERE agent_id=? AND id=? AND revision=?",
			)
			.get(id, grantId, revision);
		if (!r) return undefined;
		const v = parseVisualGrant(JSON.parse(String(r["data"])));
		if (
			v.agentId !== id ||
			v.id !== grantId ||
			v.revision !== revision ||
			visualDigest(v) !== r["digest"]
		)
			throw Error("corrupt visual grant history");
		return v;
	}
	grants(id: string): VisualGrant[] {
		return this.db
			.prepare(
				"SELECT id FROM agent_visual_grants WHERE agent_id=? ORDER BY id",
			)
			.all(id)
			.map((r) => requireVisualRecord(this.grant(id, String(r["id"]))));
	}
	freeze(id: string, purpose: VisualPurpose): FrozenVisualIdentity {
		const p = parseVisualPurpose(purpose),
			v = this.state.get(id),
			reference = v.canonicalReferenceId
				? this.reference(id, v.canonicalReferenceId)
				: null;
		if (!reference && !v.textIdentity)
			throw Error("visual identity not configured");
		const subject = reference
			? {
					kind: "reference",
					referenceId: reference.id,
					sha256: reference.sha256,
				}
			: { kind: "text_identity", identityDigest: visualIdentityDigest(v) };
		const grant = this.grants(id).find(
			(g) =>
				!g.revoked &&
				g.providerUse &&
				isDeepStrictEqual(g.subject, subject) &&
				g.purposes.some((x) => isDeepStrictEqual(x, p)),
		);
		if (!grant) throw Error("visual provider permission denied");
		return {
			agentId: id,
			profileRevision: this.state.requireProfile(id).revision,
			visualRevision: v.revision,
			avatarPolicyRevision: v.avatarPolicyRevision,
			anchors: v.anchors,
			textIdentity: v.textIdentity,
			reference: reference ?? null,
			grants: [{ grantId: grant.id, revision: grant.revision, purpose: p }],
		};
	}
	frozen(
		id: string,
		revision: number,
		profileRevision: number,
		grants: VisualGrantRef[],
	): FrozenVisualIdentity {
		const v = this.state.at(id, revision);
		if (!v) throw Error("missing visual history");
		return {
			agentId: id,
			profileRevision,
			visualRevision: revision,
			avatarPolicyRevision: v.avatarPolicyRevision,
			anchors: v.anchors,
			textIdentity: v.textIdentity,
			reference: v.canonicalReferenceId
				? (this.reference(id, v.canonicalReferenceId) ?? null)
				: null,
			grants,
		};
	}
	identityAllowed(
		f: FrozenVisualIdentity,
		phase: "provider" | "destination",
		historical = false,
	): boolean {
		const v = this.state.at(f.agentId, f.visualRevision);
		if (
			!v ||
			v.avatarPolicyRevision !== f.avatarPolicyRevision ||
			!this.state.profiles.associated(v, f.profileRevision) ||
			!isDeepStrictEqual(
				this.frozen(f.agentId, f.visualRevision, f.profileRevision, f.grants),
				f,
			)
		)
			return false;
		if ((!f.reference && !f.textIdentity) || f.grants.length === 0)
			return false;
		const subject = f.reference
			? {
					kind: "reference",
					referenceId: f.reference.id,
					sha256: f.reference.sha256,
				}
			: { kind: "text_identity", identityDigest: visualIdentityDigest(f) };
		return f.grants.every((ref) => {
			const original = this.grantAtVisual(
				f.agentId,
				ref.grantId,
				f.visualRevision,
			);
			if (
				this.grantVisualRevision(f.agentId, ref.grantId, ref.revision) >
				f.visualRevision
			)
				return false;
			if (
				!original ||
				original.revision !== ref.revision ||
				original.revoked ||
				!original.providerUse ||
				!isDeepStrictEqual(original.subject, subject) ||
				!original.purposes.some((p) => isDeepStrictEqual(p, ref.purpose))
			)
				return false;
			if (historical) return true;
			const current = this.grant(f.agentId, ref.grantId);
			return Boolean(
				current &&
					!current.revoked &&
					(phase === "destination" || current.providerUse) &&
					isDeepStrictEqual(current.subject, subject) &&
					current.purposes.some((p) => isDeepStrictEqual(p, ref.purpose)),
			);
		});
	}
	private assertSubject(g: VisualGrant, v: AgentVisual): void {
		if (g.subject.kind === "reference") {
			const ref = this.reference(g.agentId, g.subject.referenceId);
			if (!ref || ref.sha256 !== g.subject.sha256)
				throw Error("visual grant reference subject conflict");
		} else if (
			!this.grant(g.agentId, g.id) &&
			(!v.textIdentity || g.subject.identityDigest !== visualIdentityDigest(v))
		)
			throw Error("visual text subject conflict");
	}
}
