import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "./types.ts";
import { validateAgentInput } from "./validation.ts";
import type { AgentVisual } from "./visual.ts";
import {
	exact,
	integer,
	requireVisualRecord,
	visualDigest,
} from "./visual-validation.ts";

type ProfileVersion = { profile: AgentProfile; visualRevision: number };
function parseProfile(value: unknown): AgentProfile {
	const fields = exact(
		value,
		"id,name,role,personality,voice,profile,appearance,interests,avatarId,evolution,revision",
	);
	const { revision, ...input } = fields;
	return { ...validateAgentInput(input), revision: integer(revision, 1) };
}
/** Exact owned versions begin at migration's actual profile, never invented prehistory. */
export class VisualProfiles {
	constructor(
		private readonly db: DatabaseSync,
		private readonly current: (id: string) => AgentProfile | undefined,
	) {}
	at(id: string, revision: number): ProfileVersion | undefined {
		integer(revision, 1);
		const row = this.db
			.prepare(
				"SELECT visual_revision,data,digest FROM agent_visual_profiles WHERE agent_id=? AND revision=?",
			)
			.get(id, revision);
		if (!row) return undefined;
		const result = {
			profile: parseProfile(JSON.parse(String(row["data"]))),
			visualRevision: integer(row["visual_revision"], 1),
		};
		if (
			result.profile.id !== id ||
			result.profile.revision !== revision ||
			visualDigest(result) !== row["digest"]
		)
			throw Error("corrupt owned profile history");
		return result;
	}
	capture(value: AgentProfile, visualRevision: number, initial = false): void {
		const profile = parseProfile(value),
			record = { profile, visualRevision: integer(visualRevision, 1) };
		if (!isDeepStrictEqual(profile, this.current(profile.id)))
			throw Error("profile snapshot is not the actual owned version");
		const old = this.at(profile.id, profile.revision);
		if (old) {
			if (!isDeepStrictEqual(old, record))
				throw Error("immutable profile version conflict");
			return;
		}
		const last = this.db
			.prepare(
				"SELECT MAX(revision) revision FROM agent_visual_profiles WHERE agent_id=?",
			)
			.get(profile.id)?.["revision"];
		if (
			initial
				? last !== null
				: last === null || Number(last) + 1 !== profile.revision
		)
			throw Error("invalid owned profile history sequence");
		this.db
			.prepare("INSERT INTO agent_visual_profiles VALUES(?,?,?,?,?)")
			.run(
				profile.id,
				profile.revision,
				visualRevision,
				JSON.stringify(profile),
				visualDigest(record),
			);
	}
	associated(visual: AgentVisual, profileRevision: number): boolean {
		const record = this.at(visual.agentId, profileRevision),
			current = this.current(visual.agentId);
		return Boolean(
			record &&
				current &&
				profileRevision <= current.revision &&
				visual.profileRevision <= profileRevision &&
				record.visualRevision <= visual.revision,
		);
	}
	assertOutcome(value: unknown, visualRevision: number): void {
		const profile = parseProfile(value),
			record = this.at(profile.id, profile.revision);
		if (
			!record ||
			record.visualRevision !== visualRevision ||
			!isDeepStrictEqual(profile, record.profile)
		)
			throw Error("avatar receipt does not match owned profile history");
	}
	audit(
		profiles: AgentProfile[],
		visualAt: (id: string, revision: number) => AgentVisual | undefined,
	): void {
		for (const current of profiles) {
			const baseline = requireVisualRecord(visualAt(current.id, 1));
			const rows = this.db
				.prepare(
					"SELECT revision FROM agent_visual_profiles WHERE agent_id=? ORDER BY revision",
				)
				.all(current.id);
			if (rows.length !== current.revision - baseline.profileRevision + 1)
				throw Error("missing owned profile history");
			let previousVisual = 1;
			for (const [i, row] of rows.entries()) {
				const record = requireVisualRecord(
						this.at(current.id, Number(row["revision"])),
					),
					v = visualAt(current.id, record.visualRevision);
				if (
					record.profile.revision !== baseline.profileRevision + i ||
					!v ||
					record.visualRevision < previousVisual ||
					!this.associated(v, record.profile.revision) ||
					(i === 0 && record.visualRevision !== 1)
				)
					throw Error("invalid owned profile visual association");
				previousVisual = record.visualRevision;
			}
			if (
				!isDeepStrictEqual(
					this.at(current.id, current.revision)?.profile,
					current,
				)
			)
				throw Error("invalid current owned profile fence");
		}
	}
}
