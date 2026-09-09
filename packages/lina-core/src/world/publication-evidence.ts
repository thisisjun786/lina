import type { AutonomySource } from "./autonomy-types.ts";
import {
	identifier,
	lifeDigest,
	MAX_LIFE_ITEMS,
	nullableId,
	revision,
} from "./life-json.ts";
import {
	type PublicationAuthority,
	type PublicationEvidenceSnapshot,
	parsePublicationAuthority,
	parsePublicationEvidence,
} from "./publication-input.ts";
import type { PublicationPrincipal } from "./publication-types.ts";

/** Read ports audit their histories; denied visibility is false, read faults throw. */
export interface Access {
	observations(
		worldId: string,
		atRevision?: number,
	): { revision: number; records: PublicationEvidenceSnapshot["records"] };
	settingsRevision(worldId: string, atRevision?: number): number;
	post(
		worldId: string,
		id: string,
		at?: { kind: "post" | "reply"; revision: number },
	): {
		id: string;
		kind: "post" | "reply";
		revision: number;
		parentId: string | null;
		/** Generated ancestors retain the grants which authorized their source. */
		grantIds?: string[];
	};
	grant(
		worldId: string,
		id: string,
		atRevision?: number,
	): { id: string; revision: number };
	view(
		source: AutonomySource,
		authority: PublicationAuthority,
	): { visible(principal: PublicationPrincipal, postId: string): boolean };
}

/** Frozen observation membership and authority, independent of storage or model execution. */
export class PublicationEvidence {
	constructor(private readonly access: Access) {}

	freeze(
		source: AutonomySource,
		atFrontier?: number,
	): PublicationEvidenceSnapshot {
		return this.snapshot(source, atFrontier);
	}

	verify(source: AutonomySource, snapshot: PublicationEvidenceSnapshot): void {
		const saved = parsePublicationEvidence(snapshot);
		const expected = this.snapshot(source, saved.revision, saved.authority);
		if (lifeDigest(expected) !== lifeDigest(saved))
			throw Error("Publication evidence history mismatch");
	}

	assertCurrent(
		source: AutonomySource,
		snapshot: PublicationEvidenceSnapshot,
	): void {
		const saved = parsePublicationEvidence(snapshot);
		// Both passes authenticate and derive the complete observation set.
		// Identical authority shares only this operation's immutable scoped reader.
		const readers = new Map<string, ReturnType<Access["view"]>>();
		const view: Access["view"] = (context, authority) => {
			const key = lifeDigest(authority),
				prior = readers.get(key);
			if (prior) return prior;
			const reader = this.access.view(context, authority);
			readers.set(key, reader);
			return reader;
		};
		if (
			lifeDigest(
				this.snapshot(source, saved.revision, saved.authority, view),
			) !== lifeDigest(saved)
		)
			throw Error("Publication evidence history mismatch");
		if (
			lifeDigest(this.snapshot(source, saved.revision, undefined, view)) !==
			lifeDigest(saved)
		)
			throw Error("Stale publication evidence");
	}

	private snapshot(
		source: AutonomySource,
		atFrontier?: number,
		saved?: PublicationAuthority,
		makeView?: Access["view"],
	): PublicationEvidenceSnapshot {
		const worldId = identifier(source.world.definition.id);
		if (source.pack.worldId !== worldId || source.config.worldId !== worldId)
			throw Error("Publication evidence source world mismatch");
		if (atFrontier !== undefined) revision(atFrontier);
		// Read the complete receipt frontier, including noops, before any filtering.
		const observations = this.access.observations(worldId, atFrontier);
		if (atFrontier !== undefined && observations.revision !== atFrontier)
			throw Error("Publication evidence frontier mismatch");
		const authority = this.authority(worldId, observations.records, saved);
		const complete = parsePublicationEvidence({
			version: 1,
			worldId,
			revision: observations.revision,
			permissionDigest: lifeDigest({
				worldId,
				config: source.config,
				definition: source.pack.life,
				roles: source.pack.roles,
				work: source.work ?? null,
				workAncestry: source.workAncestry ?? null,
				authority,
			}),
			authority,
			records: observations.records,
		});
		const view = makeView
			? makeView(source, complete.authority)
			: this.access.view(source, complete.authority);
		return {
			...complete,
			records: complete.records.filter(({ source: record }) => {
				const original = view.visible(record.principal, record.postId);
				const recipient = view.visible(
					{ kind: "agent", agentId: record.recipientAgentId },
					record.postId,
				);
				return original && recipient;
			}),
		};
	}

	private authority(
		worldId: string,
		records: PublicationEvidenceSnapshot["records"],
		saved?: PublicationAuthority,
	): PublicationAuthority {
		const posts = this.posts(worldId, records, saved);
		const grants = new Map<string, PublicationAuthority["grants"][number]>();
		const savedGrants = new Map(saved?.grants.map((row) => [row.id, row]));
		const requiredGrants = new Set<string>();
		for (const { source } of records) {
			if (source.principal.kind !== "viewer") continue;
			requiredGrants.add(source.principal.grantId);
		}
		for (const ref of posts) {
			const post = this.access.post(worldId, ref.id, {
				kind: ref.kind,
				revision: ref.revision,
			});
			for (const id of post.grantIds ?? []) requiredGrants.add(identifier(id));
		}
		for (const id of requiredGrants) {
			const ref = savedGrants.get(id);
			if (saved && !ref)
				throw Error("Missing publication evidence grant reference");
			const row = this.access.grant(worldId, id, ref?.revision);
			if (row.id !== id || (ref && row.revision !== ref.revision))
				throw Error("Publication evidence grant reference mismatch");
			grants.set(id, { id: row.id, revision: row.revision });
		}
		const authority = parsePublicationAuthority({
			settingsRevision: this.access.settingsRevision(
				worldId,
				saved?.settingsRevision,
			),
			posts,
			grants: [...grants.values()],
		});
		// Includes references used only by denied observations; extra refs also fail.
		if (saved && lifeDigest(authority) !== lifeDigest(saved))
			throw Error("Publication evidence authority membership mismatch");
		return authority;
	}

	private posts(
		worldId: string,
		records: PublicationEvidenceSnapshot["records"],
		saved?: PublicationAuthority,
	): PublicationAuthority["posts"] {
		const posts = new Map<string, PublicationAuthority["posts"][number]>();
		const savedPosts = new Map(saved?.posts.map((row) => [row.id, row]));
		for (const { source } of records) {
			let id: string | null = identifier(source.postId);
			const path = new Set<string>();
			while (id !== null) {
				if (path.has(id)) throw Error("Publication evidence parent cycle");
				if (posts.has(id)) break;
				if (posts.size >= MAX_LIFE_ITEMS)
					throw Error("Publication evidence parent capacity exceeded");
				path.add(id);
				const ref = savedPosts.get(id);
				if (saved && !ref)
					throw Error("Missing publication evidence post reference");
				const row = this.access.post(
					worldId,
					id,
					ref ? { kind: ref.kind, revision: ref.revision } : undefined,
				);
				if (
					row.id !== id ||
					(ref && (row.kind !== ref.kind || row.revision !== ref.revision))
				)
					throw Error("Publication evidence post reference mismatch");
				posts.set(id, { id: row.id, kind: row.kind, revision: row.revision });
				id = nullableId(row.parentId);
			}
			const observedPost = posts.get(source.postId);
			if (!observedPost || source.postRevision > observedPost.revision)
				throw Error("Publication evidence observed post revision mismatch");
		}
		return [...posts.values()];
	}
}
