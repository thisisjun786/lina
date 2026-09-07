import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { AuthoringPersistence } from "./authoring-persistence.ts";
import { parseWorldSuggestionResult } from "./authoring-suggestion.ts";
import type {
	WorldAuthorScope,
	WorldSuggestion,
	WorldSuggestionRequest,
	WorldSuggestionResult,
} from "./authoring-types.ts";
import { parseWorldSuggestionRequest } from "./authoring-validation.ts";
import { canonicalLifeJson, lifeDigest } from "./life-json.ts";
import { fields, id, integer, text } from "./validation.ts";

type Owner = { id: string; pid: number; start: string | null };
type Row = {
	request_id: string;
	draft_id: string;
	draft_revision: number;
	request_json: string;
	input_digest: string;
	dispatch_owner_json: string | null;
};
function start(pid: number): string | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}
function alive(owner: Owner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	const current = start(owner.pid);
	return owner.start === null || current === null || owner.start === current;
}
function readOwner(raw: string | null): Owner | null {
	if (raw === null) return null;
	const value: unknown = JSON.parse(raw);
	fields(value, ["id", "pid", "start"]);
	id(value.id);
	integer(value.pid, "dispatch process", 1);
	if (
		value.start !== null &&
		(typeof value.start !== "string" || !/^[0-9]+$/.test(value.start))
	)
		throw Error("Corrupt author dispatch owner");
	return value as Owner;
}

/** The dispatch marker precedes the provider call; unknown outcomes never cause an automatic retry. */
export class AuthoringRequests {
	private readonly owner: Owner = {
		id: randomUUID(),
		pid: process.pid,
		start: start(process.pid),
	};
	constructor(
		private readonly db: DatabaseSync,
		private readonly author: AuthoringPersistence,
	) {}
	private row(requestId: string): Row {
		id(requestId);
		const row = this.db
			.prepare("SELECT * FROM world_authoring_requests WHERE request_id = ?")
			.get(requestId) as Row | undefined;
		if (!row) throw Error("Unknown world suggestion request");
		return row;
	}
	private decode(row: Row): WorldSuggestion {
		const value: unknown = JSON.parse(row.request_json);
		fields(value, [
			"version",
			"input",
			"inputDigest",
			"scope",
			"status",
			"result",
			"error",
		]);
		const input = parseWorldSuggestionRequest(value.input);
		if (
			value.version !== 1 ||
			![
				"prepared",
				"dispatched",
				"unknown",
				"succeeded",
				"failed",
				"abandoned",
			].includes(value.status as string) ||
			![
				null,
				"invalid_result",
				"stale",
				"revoked",
				"dispatch_unknown",
			].includes(value.error as null)
		)
			throw Error("Invalid world suggestion state");
		const scope = value.scope;
		if (!scope || typeof scope !== "object")
			throw Error("Invalid suggestion scope");
		if ("kind" in scope) {
			fields(scope, ["kind"]);
			if (scope.kind !== "management") throw Error("Invalid suggestion scope");
		} else {
			fields(scope, ["grantId", "grantRevision"]);
			id(scope.grantId);
			integer(scope.grantRevision, "grant revision", 1);
		}
		const request = value as unknown as WorldSuggestion;
		if (
			row.request_id !== input.requestId ||
			row.draft_id !== input.draftId ||
			row.draft_revision !== input.draftRevision ||
			row.input_digest !== request.inputDigest ||
			request.inputDigest !== lifeDigest({ input, scope })
		)
			throw Error("Corrupt suggestion provenance");
		const original = this.author.draftAt(input.draftId, input.draftRevision),
			owner = readOwner(row.dispatch_owner_json);
		if (
			(request.status === "prepared" && owner !== null) ||
			(["dispatched", "unknown", "succeeded"].includes(request.status) &&
				owner === null)
		)
			throw Error("Corrupt suggestion dispatch marker");
		if (request.status === "succeeded") {
			fields(request.result, ["draft", "provider", "model"]);
			text(request.result.provider, "provider");
			text(request.result.model, "model");
			if (request.error !== null) throw Error("Corrupt successful suggestion");
			const saved = this.author.draftAt(input.draftId, input.draftRevision + 1);
			if (
				!isDeepStrictEqual(request.result.draft, saved) ||
				saved.authoredText !== original.authoredText ||
				!isDeepStrictEqual(saved.suggestion, {
					requestId: input.requestId,
					provider: request.result.provider,
					model: request.result.model,
					inputDigest: request.inputDigest,
				})
			)
				throw Error("Corrupt suggestion result revision");
		} else if (request.result !== null)
			throw Error("Unconfirmed suggestion has a result");
		if (
			["prepared", "dispatched"].includes(request.status) &&
			request.error !== null
		)
			throw Error("Corrupt pending suggestion error");
		if (request.status === "unknown" && request.error !== "dispatch_unknown")
			throw Error("Corrupt uncertain suggestion");
		if (
			request.status === "failed" &&
			(request.error === null ||
				request.error === "dispatch_unknown" ||
				(request.error === "invalid_result" && owner === null))
		)
			throw Error("Corrupt failed suggestion state");
		if (
			request.status === "abandoned" &&
			((request.error !== null && request.error !== "dispatch_unknown") ||
				(request.error === "dispatch_unknown" && owner === null))
		)
			throw Error("Corrupt abandoned suggestion state");
		if (!("kind" in request.scope)) {
			const grant = this.author.worldAuthorGrant(request.scope.grantId);
			if (
				grant.worldId !== original.worldId ||
				grant.agentId !== input.agentId ||
				request.scope.grantRevision !== 1
			)
				throw Error("Corrupt suggestion grant provenance");
		}
		return request;
	}
	private authorize(request: WorldSuggestion, scope?: WorldAuthorScope): void {
		const original = this.author.draftAt(
			request.input.draftId,
			request.input.draftRevision,
		);
		const selected = this.author.authorize(original.worldId, scope);
		if (!("kind" in selected) && !isDeepStrictEqual(selected, request.scope))
			throw Error("World suggestion grant mismatch");
	}
	prepare(
		input: WorldSuggestionRequest,
		scope?: WorldAuthorScope,
	): WorldSuggestion {
		const parsed = parseWorldSuggestionRequest(input),
			prior = this.db
				.prepare("SELECT * FROM world_authoring_requests WHERE request_id = ?")
				.get(parsed.requestId) as Row | undefined;
		const normalizedScope = scope ?? { kind: "management" as const },
			digest = lifeDigest({ input: parsed, scope: normalizedScope });
		if (prior) {
			const request = this.decode(prior);
			this.authorize(request, scope);
			if (request.inputDigest !== digest)
				throw Error("World suggestion idempotency conflict");
			return request;
		}
		const draft = this.author.worldDraft(parsed.draftId, scope);
		if (draft.revision !== parsed.draftRevision)
			throw Error("World draft revision conflict");
		if (
			!("kind" in normalizedScope) &&
			this.author.worldAuthorGrant(normalizedScope.grantId).agentId !==
				parsed.agentId
		)
			throw Error("World suggestion guide mismatch");
		for (const row of this.db
			.prepare(
				"SELECT * FROM world_authoring_requests WHERE draft_id = ? AND draft_revision = ?",
			)
			.all(parsed.draftId, parsed.draftRevision) as Row[])
			if (
				["prepared", "dispatched", "unknown"].includes(this.decode(row).status)
			)
				throw Error(
					"Unresolved world suggestion already exists for this revision",
				);
		const request: WorldSuggestion = {
			version: 1,
			input: parsed,
			inputDigest: digest,
			scope: normalizedScope,
			status: "prepared",
			result: null,
			error: null,
		};
		this.db
			.prepare(
				"INSERT INTO world_authoring_requests (request_id, draft_id, draft_revision, request_json, input_digest, dispatch_owner_json) VALUES (?, ?, ?, ?, ?, NULL)",
			)
			.run(
				parsed.requestId,
				parsed.draftId,
				parsed.draftRevision,
				canonicalLifeJson(request),
				digest,
			);
		return request;
	}
	get(requestId: string, scope?: WorldAuthorScope): WorldSuggestion {
		const request = this.decode(this.row(requestId));
		this.authorize(request, scope);
		return request;
	}
	private save(request: WorldSuggestion): WorldSuggestion {
		this.decode({
			...this.row(request.input.requestId),
			request_json: canonicalLifeJson(request),
		});
		this.db
			.prepare(
				"UPDATE world_authoring_requests SET request_json = ? WHERE request_id = ?",
			)
			.run(canonicalLifeJson(request), request.input.requestId);
		return request;
	}
	dispatch(
		requestId: string,
		scope?: WorldAuthorScope,
	): { request: WorldSuggestion; dispatched: boolean } {
		const request = this.get(requestId, scope);
		if (request.status !== "prepared") return { request, dispatched: false };
		const draft = this.author.worldDraft(request.input.draftId, scope);
		if (draft.revision !== request.input.draftRevision)
			return {
				request: this.fail(requestId, "stale", scope),
				dispatched: false,
			};
		this.db
			.prepare(
				"UPDATE world_authoring_requests SET dispatch_owner_json = ? WHERE request_id = ?",
			)
			.run(canonicalLifeJson(this.owner), requestId);
		return {
			request: this.save({ ...request, status: "dispatched" }),
			dispatched: true,
		};
	}
	finish(
		requestId: string,
		input: WorldSuggestionResult,
		scope?: WorldAuthorScope,
	): WorldSuggestion {
		const request = this.get(requestId, scope);
		const result = parseWorldSuggestionResult(input),
			pack = result.pack;
		if (request.status === "succeeded") {
			if (
				!isDeepStrictEqual(request.result?.draft.pack, pack) ||
				(result.pack === null &&
					!isDeepStrictEqual(
						request.result?.draft.unresolved,
						result.unresolved,
					)) ||
				request.result?.provider !== result.provider ||
				request.result.model !== result.model
			)
				throw Error("World suggestion result conflict");
			return request;
		}
		if (!["dispatched", "unknown"].includes(request.status))
			throw Error("World suggestion cannot accept a late result");
		// Stored grant, not the caller's management privilege, owns the response application.
		this.author.authorize(
			this.author.draftAt(request.input.draftId, request.input.draftRevision)
				.worldId,
			request.scope,
		);
		const current = this.author.worldDraft(request.input.draftId, scope);
		if (current.revision !== request.input.draftRevision)
			return this.fail(requestId, "stale", scope);
		const draft = this.author.applySuggestion(
			request.input.draftId,
			request.input.draftRevision,
			result,
			{
				requestId,
				provider: result.provider,
				model: result.model,
				inputDigest: request.inputDigest,
			},
			request.scope,
		);
		return this.save({
			...request,
			status: "succeeded",
			error: null,
			result: { draft, provider: result.provider, model: result.model },
		});
	}
	fail(
		requestId: string,
		reason: NonNullable<WorldSuggestion["error"]>,
		scope?: WorldAuthorScope,
	): WorldSuggestion {
		const request = this.get(requestId, scope);
		if (
			!["invalid_result", "stale", "revoked", "dispatch_unknown"].includes(
				reason,
			)
		)
			throw Error("Invalid suggestion failure");
		if (!["prepared", "dispatched", "unknown"].includes(request.status))
			return request;
		if (reason === "dispatch_unknown" && request.status === "prepared")
			throw Error("Undispatched suggestion cannot be uncertain");
		return this.save({
			...request,
			status: reason === "dispatch_unknown" ? "unknown" : "failed",
			error: reason,
		});
	}
	abandon(requestId: string, scope?: WorldAuthorScope): WorldSuggestion {
		const request = this.get(requestId, scope);
		if (["succeeded", "failed", "abandoned"].includes(request.status))
			return request;
		return this.save({ ...request, status: "abandoned" });
	}
	audit(): void {
		const pending = new Set<string>();
		for (const row of this.db
			.prepare("SELECT * FROM world_authoring_requests")
			.all() as Row[]) {
			const request = this.decode(row),
				key = `${row.draft_id}:${row.draft_revision}`;
			if (["prepared", "dispatched", "unknown"].includes(request.status)) {
				if (pending.has(key))
					throw Error("Duplicate unresolved world suggestion");
				pending.add(key);
			}
		}
		for (const row of this.db
			.prepare(
				"SELECT draft_json FROM world_draft_versions WHERE json_type(draft_json, '$.suggestion') = 'object'",
			)
			.all() as Array<{ draft_json: string }>) {
			const draft = JSON.parse(row.draft_json) as {
				revision: number;
				suggestion: { requestId: string };
			};
			const request = this.decode(this.row(draft.suggestion.requestId));
			if (
				request.status !== "succeeded" ||
				request.result?.draft.revision !== draft.revision
			)
				throw Error("Orphan suggested world draft");
		}
	}
	recover(): void {
		this.release(false);
	}
	close(): void {
		this.release(true);
	}
	private release(owned: boolean): void {
		for (const row of this.db
			.prepare("SELECT * FROM world_authoring_requests")
			.all() as Row[]) {
			const request = this.decode(row),
				owner = readOwner(row.dispatch_owner_json);
			if (
				request.status === "dispatched" &&
				owner &&
				(owned ? owner.id === this.owner.id : !alive(owner))
			)
				this.save({ ...request, status: "unknown", error: "dispatch_unknown" });
		}
	}
}
