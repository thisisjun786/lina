import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, hash } from "../../../lina-memory/src/resources/codec.ts";
import { readResource } from "../../../lina-memory/src/resources/retrieval.ts";
import type { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type {
	Resource,
	ResourceScope,
	ResourceVersionRef,
} from "../../../lina-memory/src/resources/types.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import { resourceEstimator } from "./worker.ts";

const requestSchema = z.strictObject({
	query: z.string().trim().min(1).max(1024),
	collectionId: z.uuid().optional(),
	cursor: z.uuid().optional(),
	limit: z.number().int().min(1).max(50).default(20),
});
const planSchema = z.strictObject({
	collectionIds: z.array(z.string()).max(32),
	terms: z.array(z.string().trim().min(1).max(256)).max(4),
});
const rankSchema = z.strictObject({ ids: z.array(z.string()).max(200) });
interface Options {
	store: ResourceStore;
	scope: () => ResourceScope;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
}
interface Candidate {
	id: string;
	title: string;
	kind: string;
	ref: ResourceVersionRef;
	brief: string | null;
	content: string | null;
	stale: boolean;
	complete: boolean;
}
interface SearchResult {
	items: Candidate[];
	method: "semantic" | "lexical";
	calls: number;
	visits: number;
	incomplete: boolean;
	reasons: string[];
	nextCursor: string | null;
}
interface Continuation {
	query: string;
	collectionId: string | null;
	items: Candidate[];
	base: Omit<SearchResult, "items" | "nextCursor">;
	guard: () => void;
}
export class ResourceSearch {
	private readonly cursors = new Map<string, Continuation>();
	constructor(private readonly options: Options) {}
	private page(value: Continuation, limit: number): SearchResult {
		value.guard();
		let nextCursor: string | null = null;
		if (value.items.length > limit) {
			nextCursor = randomUUID();
			this.cursors.set(nextCursor, {
				...value,
				items: value.items.slice(limit),
			});
			while (this.cursors.size > 32) {
				const oldest = this.cursors.keys().next().value;
				if (oldest) this.cursors.delete(oldest);
			}
		}
		return { ...value.base, items: value.items.slice(0, limit), nextCursor };
	}
	assertCurrent(items: readonly Candidate[]): void {
		const { store, scope } = this.options;
		for (const item of items) {
			if (!store.current(scope(), [item.ref]))
				throw Error("resource search source changed");
			const r = store.get(scope(), item.id),
				brief = readResource(store, scope(), item.id, {
					level: r.kind === "collection" ? "overview" : "brief",
					limit: 512,
				}),
				content =
					r.kind === "document"
						? readResource(store, scope(), item.id, {
								level: "content",
								limit: 1024,
							})
						: null;
			if (brief.text !== item.brief || (content?.text ?? null) !== item.content)
				throw Error("resource search derivation changed");
		}
	}
	async search(
		raw: z.input<typeof requestSchema>,
		signal: AbortSignal,
	): Promise<SearchResult> {
		const input = requestSchema.parse(raw),
			{ store, scope, services, policy } = this.options,
			settings = policy(),
			svc = services();
		signal.throwIfAborted();
		if (input.cursor) {
			const cursor = this.cursors.get(input.cursor);
			if (
				!cursor ||
				cursor.query !== input.query ||
				cursor.collectionId !== (input.collectionId ?? null)
			)
				throw Error("resource cursor unavailable");
			return { ...this.page(cursor, input.limit), calls: 0 };
		}
		const reasons = new Set<string>(),
			seen = new Set<string>(),
			candidates = new Map<string, Candidate>();
		let calls = 0;
		const rootRef = input.collectionId
			? store.ref(scope(), input.collectionId)
			: null;
		const scopeKey = canonical(scope()),
			policyKey = canonical(settings),
			routeKey = () => {
				const live = services();
				return hash({
					plan:
						live.routeInfo?.(
							"recall",
							undefined,
							settings.resources.outputTokens,
						) ?? null,
					key: live.summaryCacheKey?.() ?? "",
					estimator: resourceEstimator(live).id,
				});
			};
		let initialRoute: string;
		try {
			initialRoute = routeKey();
		} catch {
			initialRoute = "unconfigured";
		}
		const describe = (r: Resource): Candidate => {
			const ref = store.ref(scope(), r.id),
				brief = readResource(store, scope(), r.id, {
					level: r.kind === "collection" ? "overview" : "brief",
					limit: 512,
				});
			const content =
				r.kind === "document"
					? readResource(store, scope(), r.id, {
							level: "content",
							limit: 1024,
						})
					: null;
			return {
				id: r.id,
				title: r.title,
				kind: r.kind,
				ref,
				brief: brief.text,
				content: content?.text ?? null,
				stale: brief.stale || (content?.stale ?? false),
				complete: brief.complete && (content?.complete ?? true),
			};
		};
		const consider = (r: Resource) => {
			if (seen.has(r.id)) return;
			if (seen.size >= settings.resources.maxVisits) {
				reasons.add("visit_limit");
				return;
			}
			seen.add(r.id);
			try {
				candidates.set(r.id, describe(r));
			} catch {
				reasons.add("source_unavailable");
			}
		};
		const page = store.list(scope(), input.collectionId ?? null, {
			limit: Math.min(settings.resources.maxVisits, 100),
		});
		if (page.nextCursor) reasons.add("browse_incomplete");
		for (const r of page.items) consider(r);
		if (!input.collectionId)
			for (const r of store.find(
				scope(),
				input.query,
				Math.min(settings.resources.maxVisits, 100),
			))
				consider(r);
		const snapshotValid = (rows: Candidate[]) => {
			signal.throwIfAborted();
			if (
				canonical(scope()) !== scopeKey ||
				canonical(policy()) !== policyKey ||
				routeKey() !== initialRoute
			)
				throw Error("context_changed");
			if (rootRef && !store.current(scope(), [rootRef]))
				throw Error("context_changed");
			for (const item of rows) {
				if (
					!store.current(scope(), [item.ref]) ||
					hash(describe(store.get(scope(), item.id))) !== hash(item)
				)
					throw Error("context_changed");
			}
		};
		const call = async (kind: "plan" | "rank", rows: Candidate[]) => {
			if (calls >= settings.resources.maxCalls) throw Error("call_limit");
			const callback = kind === "plan" ? svc.planResources : svc.rankResources;
			const overhead = svc.resourceInputOverhead?.(kind);
			if (!callback || overhead === undefined)
				throw Error("provider_unconfigured");
			const estimator = resourceEstimator(svc),
				empty = estimator.messages([{ role: "user", content: "" }]);
			const offered = [...rows];
			let text = "";
			while (true) {
				text = JSON.stringify({
					query: input.query,
					[kind === "plan" ? "collections" : "candidates"]: offered,
				});
				if (
					overhead +
						estimator.messages([{ role: "user", content: text }]) -
						empty <=
					settings.resources.inputTokens
				)
					break;
				if (!offered.length) throw Error("input_budget_insufficient");
				offered.pop();
				reasons.add("input_budget_insufficient");
			}
			let dispatched = false;
			const guard = () => {
				snapshotValid(offered);
				if (!dispatched) {
					if (calls >= settings.resources.maxCalls) throw Error("call_limit");
					calls++;
					dispatched = true;
				}
			};
			const result = await callback(
				text,
				signal,
				guard,
				undefined,
				settings.resources.outputTokens,
				settings.resources.inputTokens,
			);
			if (!dispatched) throw Error("dispatch_guard_missing");
			snapshotValid(offered);
			if (estimator.text(result) > settings.resources.outputTokens)
				throw Error("invalid_model_output");
			return { result, offered };
		};
		let ids: string[] = [],
			method: "semantic" | "lexical" = "lexical";
		try {
			if ([...input.query].length < 3) throw Error("short_query_literal");
			if (
				!settings.resources.enabled ||
				!svc.planResources ||
				!svc.rankResources
			)
				throw Error("provider_unconfigured");
			let collections = [...candidates.values()].filter(
				(c) => c.kind === "collection",
			);
			const expanded = new Set<string>();
			while (collections.length) {
				if (calls >= settings.resources.maxCalls - 1) {
					reasons.add("call_limit");
					break;
				}
				const response = await call("plan", collections);
				const nextCollections: Candidate[] = [];
				let plan: z.infer<typeof planSchema>;
				try {
					plan = planSchema.parse(JSON.parse(response.result));
				} catch {
					throw Error("invalid_model_output");
				}
				const allowed = new Set(response.offered.map((v) => v.id));
				if (
					new Set(plan.collectionIds).size !== plan.collectionIds.length ||
					plan.collectionIds.some((id) => !allowed.has(id))
				)
					throw Error("invalid_model_output");
				for (const id of plan.collectionIds) {
					if (expanded.has(id)) continue;
					expanded.add(id);
					const childPage = store.list(scope(), id, {
						limit: Math.min(settings.resources.maxVisits, 100),
					});
					if (childPage.nextCursor) reasons.add("browse_incomplete");
					for (const r of childPage.items) {
						consider(r);
						const candidate = candidates.get(r.id);
						if (candidate?.kind === "collection" && !expanded.has(r.id))
							nextCollections.push(candidate);
					}
				}
				// Collection-restricted searches never broaden through global follow-up terms.
				if (!input.collectionId)
					for (const term of plan.terms)
						for (const r of store.find(
							scope(),
							term,
							Math.min(settings.resources.maxVisits, 100),
						))
							consider(r);
				collections = nextCollections;
			}
			const response = await call("rank", [...candidates.values()]);
			let rank: z.infer<typeof rankSchema>;
			try {
				rank = rankSchema.parse(JSON.parse(response.result));
			} catch {
				throw Error("invalid_model_output");
			}
			const allowed = new Set(response.offered.map((v) => v.id));
			if (
				new Set(rank.ids).size !== rank.ids.length ||
				rank.ids.some((id) => !allowed.has(id))
			)
				throw Error("invalid_model_output");
			ids = rank.ids;
			method = "semantic";
		} catch (error) {
			signal.throwIfAborted();
			const message =
				error instanceof Error ? error.message : "provider_failed";
			reasons.add(
				[
					"call_limit",
					"context_changed",
					"invalid_model_output",
					"provider_unconfigured",
					"input_budget_insufficient",
					"dispatch_guard_missing",
					"short_query_literal",
				].includes(message)
					? message
					: "provider_failed",
			);
			ids = [...candidates.values()]
				.filter((c) =>
					`${c.title}\n${c.brief ?? ""}\n${c.content ?? ""}`
						.toLocaleLowerCase()
						.includes(input.query.toLocaleLowerCase()),
				)
				.map((c) => c.id);
		}
		const items: Candidate[] = [];
		for (const id of ids) {
			const item = candidates.get(id);
			if (!item) continue;
			try {
				if (
					canonical(scope()) !== scopeKey ||
					!store.current(scope(), [item.ref]) ||
					hash(describe(store.get(scope(), id))) !== hash(item) ||
					(rootRef && !store.current(scope(), [rootRef]))
				)
					throw Error("changed");
				items.push(item);
			} catch {
				reasons.add("source_changed");
			}
		}
		if ([...candidates.values()].some((c) => !c.complete))
			reasons.add("content_incomplete");
		const base = {
			method,
			calls,
			visits: seen.size,
			incomplete: reasons.size > 0,
			reasons: [...reasons],
		};
		// Ephemeral opaque cursors expire on service restart; they never grant scope.
		const continuation = {
			query: input.query,
			collectionId: input.collectionId ?? null,
			items,
			base,
			guard: () => {
				if (
					canonical(scope()) !== scopeKey ||
					canonical(policy()) !== policyKey
				)
					throw Error("resource cursor context changed");
				if (rootRef && !store.current(scope(), [rootRef]))
					throw Error("resource cursor context changed");
				this.assertCurrent(items);
			},
		};
		if (!items.length) return { ...base, items, nextCursor: null };
		return this.page(continuation, input.limit);
	}
}
