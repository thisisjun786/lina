import { isDeepStrictEqual } from "node:util";
import type {
	GenerationOwner,
	QualifiedHonchoAdapter,
} from "../src/honcho/types.ts";
import { FakeHoncho } from "./honcho-fixture.ts";

// /fixture/* is a synthetic qualification protocol owned by this test server.
// These paths are NOT Honcho endpoints or a production qualification claim.
export class HonchoHttpFixture {
	readonly seen: { path: string; body: unknown }[] = [];
	readonly namespaces = new Map<
		string,
		{ owner: GenerationOwner; fake: FakeHoncho }
	>();
	fault: "owner" | "scope" | "unqualified" | "provenance" | undefined;
	beforeRecall: (() => Promise<void>) | undefined;
	readonly server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (request) => {
			const path = new URL(request.url).pathname;
			const body = (await request.json()) as Record<string, unknown>;
			this.seen.push({ path, body });
			if (path.startsWith("/fixture/")) {
				const owner = body["owner"] as GenerationOwner;
				const selected = this.namespaces.get(owner?.binding?.botId);
				if (!selected || !isDeepStrictEqual(owner, selected.owner))
					return Response.json({ error: "foreign owner" }, { status: 403 });
				const proof = {
					version: 1,
					owner: structuredClone(selected.owner),
					isolation: "workspace",
					ordinaryOnly: true,
				};
				if (this.fault === "owner")
					proof.owner.ordinaryNamespace.ownerBotId = "other";
				if (this.fault === "scope")
					proof.owner.identity.workspaceId = "foreign";
				if (this.fault === "unqualified") proof.ordinaryOnly = false;
				if (path === "/fixture/qualify") return Response.json(proof);
				const sourceProofs = selected.fake.messages.flatMap(
					(m) =>
						(m.metadata["lina"] as { sourceProofs: unknown[] }).sourceProofs,
				);
				const unique = [
					...new Map(
						sourceProofs.map((p) => [(p as { entryId: string }).entryId, p]),
					).values(),
				];
				// Freeze the remote snapshot BEFORE yielding so a policy change cannot be
				// papered over by manufacturing fresh provenance from the local resolver.
				const response = {
					text: selected.fake.messages.map((m) => m.content).join("\n"),
					proof: {
						...proof,
						sourceProofs: this.fault === "provenance" ? [] : unique,
					},
				};
				await this.beforeRecall?.();
				return Response.json(response);
			}
			for (const { owner, fake } of this.namespaces.values()) {
				if (
					(path === "/v3/workspaces" &&
						body["id"] === owner.identity.workspaceId) ||
					path.startsWith(`/v3/workspaces/${owner.identity.workspaceId}/`)
				)
					return fake.fetch(request.url, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
						signal: request.signal,
					});
			}
			return Response.json(
				{ error: "unregistered destination" },
				{ status: 403 },
			);
		},
	});
	get baseUrl() {
		return this.server.url.origin;
	}
	register(owner: GenerationOwner) {
		this.namespaces.set(owner.binding.botId, {
			owner: structuredClone(owner),
			fake: new FakeHoncho(owner.identity),
		});
	}
	readonly adapter: QualifiedHonchoAdapter = {
		qualify: (owner, signal) => this.call("qualify", { owner }, signal),
		recall: (request, signal) => this.call("recall", request, signal),
	};
	private async call(
		path: string,
		body: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}/fixture/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			...(signal ? { signal } : {}),
		});
		if (!response.ok)
			throw new Error(`fixture qualification ${response.status}`);
		return response.json();
	}
	close() {
		this.server.stop(true);
	}
}
