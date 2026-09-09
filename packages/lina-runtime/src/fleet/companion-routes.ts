import { CompanionMemory } from "../context/companion.ts";
import type {
	EnginePolicyInput,
	EnginePolicySettingsStore,
} from "../context/policy-settings.ts";
import { ModelRequestError } from "../models/errors.ts";
import type { CatalogModel } from "../models/port.ts";
import type {
	ModelReasoning,
	ModelRole,
	ModelSettingsInput,
} from "../models/types.ts";
import { parseModelSettingsInput } from "../models/validation.ts";
import type { AgentFleet } from "./manager.ts";

const busyTests = new WeakSet<AgentFleet>();
function publicTestMessage(error: unknown): string {
	if (error instanceof ModelRequestError) return error.message;
	const code =
		error instanceof Error &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
			? (error as { code: string }).code
			: undefined;
	if (code === "reasoning_unsupported")
		return "선택한 추론 수준을 이 모델이 지원하지 않습니다.";
	if (code === "output_budget_exceeded")
		return "설정한 출력 한도가 현재 모델 한도를 넘습니다.";
	if (code === "not_configured")
		return "시험할 모델과 열린 대화방을 확인해주세요.";
	if (code === "model_unavailable") return "선택한 모델의 연결을 확인해주세요.";
	return "모델이 시험 응답을 완료하지 못했습니다. 운영 기억은 변경하지 않았습니다.";
}
const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
function fields(input: Record<string, unknown>, keys: string[]) {
	if (
		Object.keys(input).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(input, k))
	)
		throw Error("Invalid request fields");
}
function catalogModel(
	catalog: CatalogModel[],
	profile: { provider: string; model: string },
) {
	return catalog.find(
		(item) => item.provider === profile.provider && item.id === profile.model,
	);
}
function profileOf(settings: ModelSettingsInput, id: string) {
	return settings.profiles.find((profile) => profile.id === id);
}
function referencedAuthBudget(
	settings: ModelSettingsInput,
	catalog: CatalogModel[],
	id: string,
	extraBudget?: number,
) {
	const profile = profileOf(settings, id);
	const model = profile && catalogModel(catalog, profile);
	if (!profile || !model?.authenticated) return false;
	if (
		profile.maxOutputTokens !== undefined &&
		profile.maxOutputTokens > model.maxOutputTokens
	)
		return false;
	return extraBudget === undefined || extraBudget <= model.maxOutputTokens;
}
function advertisedEffortOk(
	settings: ModelSettingsInput,
	catalog: CatalogModel[],
	id: string,
	requested?: ModelReasoning,
) {
	const profile = profileOf(settings, id);
	const model = profile && catalogModel(catalog, profile);
	if (!profile || !model) return false;
	if (!model.reasoning) return true;
	const effort = requested ?? profile.reasoning;
	return (
		effort === "off" ||
		!model.reasoningEfforts ||
		model.reasoningEfforts.includes(effort)
	);
}
function referencedRoleCapable(
	settings: ModelSettingsInput,
	catalog: CatalogModel[],
	id: string,
	role: ModelRole | null,
) {
	const profile = profileOf(settings, id);
	const model = profile && catalogModel(catalog, profile);
	if (!profile || !model) return false;
	return (
		(!model.supportedRoles ||
			model.supportedRoles.includes(role ?? "conversation")) &&
		(role !== "vision" || model.imageInput === true)
	);
}
function referencedBindingOk(
	settings: ModelSettingsInput,
	catalog: CatalogModel[],
	id: string,
	role: ModelRole | null,
) {
	return (
		referencedAuthBudget(settings, catalog, id) &&
		advertisedEffortOk(settings, catalog, id) &&
		referencedRoleCapable(settings, catalog, id, role)
	);
}
/**
 * Validates only profiles a binding actually references, so stale unused
 * profiles never block unrelated saves. Explicit vision bindings need an
 * image-capable model; an inherited text-only default is allowed and the
 * runtime reports a clear error instead. Desired reasoning is kept even on
 * non-reasoning models; the host normalizes the actual call to off.
 * Tier profiles are checked for auth, catalog presence, output budget and
 * advertised effort even when no roleTiers entry is active. Unbound tiers
 * do not inherit a conversation supportedRoles requirement. Active roleTiers
 * enforce the named role, including vision image input.
 */
function referencedBindingsValid(
	settings: ModelSettingsInput,
	catalog: CatalogModel[],
): boolean {
	const bindings: Array<[ModelRole | null, string]> = [];
	if (settings.defaultProfileId !== null)
		bindings.push([null, settings.defaultProfileId]);
	const maps = [settings.roles, ...Object.values(settings.agentRoles)];
	for (const map of maps)
		for (const [role, id] of Object.entries(map))
			if (id !== undefined && (!settings.routes || role === "conversation"))
				bindings.push([role as ModelRole, id]);
	if (
		!bindings.every(([role, id]) =>
			referencedBindingOk(settings, catalog, id, role),
		)
	)
		return false;
	const routes = settings.routes;
	if (!routes) return true;
	for (const binding of Object.values(routes.tiers)) {
		if (
			!referencedAuthBudget(
				settings,
				catalog,
				binding.profileId,
				binding.maxOutputTokens,
			) ||
			!advertisedEffortOk(
				settings,
				catalog,
				binding.profileId,
				binding.reasoning,
			)
		)
			return false;
	}
	for (const role of Object.getOwnPropertyNames(routes.roleTiers)) {
		if (role === "conversation") return false;
		const tier = routes.roleTiers[role as Exclude<ModelRole, "conversation">];
		if (!tier) return false;
		if (
			!referencedRoleCapable(
				settings,
				catalog,
				routes.tiers[tier].profileId,
				role as ModelRole,
			)
		)
			return false;
	}
	return true;
}
export async function companionRoutes(
	request: Request,
	fleet: AgentFleet,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url),
		path = url.pathname;
	if (
		!path.startsWith("/api/models") &&
		!/^\/api\/agents\/[^/]+\/mind/.test(path)
	)
		return;
	if (url.search) return reply({ error: "요청 주소를 확인해주세요." }, 400);
	try {
		if (path === "/api/models" && request.method === "GET")
			return reply(fleet.modelState());
		if (path === "/api/models/settings" && request.method === "PATCH") {
			const value = await json();
			fields(value, ["revision", "settings"]);
			if (typeof value["revision"] !== "number")
				throw Error("Invalid revision");
			const settings = parseModelSettingsInput(value["settings"]);
			const catalog = fleet.modelState().catalog;
			if (!referencedBindingsValid(settings, catalog))
				return reply(
					{ error: "선택한 모델의 연결·이미지 지원·출력 한도를 확인해주세요." },
					400,
				);
			for (const id of [
				...Object.keys(settings.agentRoles),
				...Object.keys(settings.agentRoleReasoning ?? {}),
			])
				if (!fleet.agents.get(id)) throw Error("Unknown agent");
			return reply({
				settings: fleet.modelSettings.replace(value["revision"], settings),
			});
		}
		if (path === "/api/models/test" && request.method === "POST") {
			if (busyTests.has(fleet))
				return reply({ error: "모델 시험이 이미 진행 중입니다." }, 409);
			const value = await json();
			fields(value, ["profileId", "prompt"]);
			if (
				typeof value["profileId"] !== "string" ||
				typeof value["prompt"] !== "string" ||
				!value["prompt"].trim() ||
				value["prompt"].length > 8000
			)
				throw Error("Invalid test input");
			const profile = fleet.modelSettings
				.snapshot()
				.profiles.find((p) => p.id === value["profileId"]);
			const control = fleet.managementModelControl();
			if (!profile || !control)
				return reply(
					{ error: "시험할 모델과 열린 대화방을 확인해주세요." },
					409,
				);
			busyTests.add(fleet);
			try {
				return reply(
					await control.test(
						profile,
						value["prompt"],
						AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
					),
				);
			} catch (error) {
				return reply(
					{
						error: publicTestMessage(error),
					},
					502,
				);
			} finally {
				busyTests.delete(fleet);
			}
		}
		const match =
			/^\/api\/agents\/([a-z][a-z0-9-]{0,47})\/mind(\/retract)?$/.exec(path);
		if (match) {
			const id = match[1] ?? "";
			if (!fleet.agents.get(id))
				return reply({ error: "에이전트를 찾지 못했습니다." }, 404);
			const app = fleet.opened(id);
			if (!app) return reply({ available: false, reason: "room-not-open" });
			if (!(app.memory instanceof CompanionMemory))
				return reply({ available: false, reason: "native-memory-disabled" });
			if (request.method === "GET" && !match[2])
				return reply({ available: true, ...app.memory.detail() });
			if (request.method === "POST" && match[2]) {
				const value = await json();
				fields(value, ["id", "revision"]);
				if (
					typeof value["id"] !== "string" ||
					typeof value["revision"] !== "number"
				)
					throw Error("Invalid record");
				app.memory.mind.retract(value["id"], value["revision"]);
				return reply({ available: true, ...app.memory.detail() });
			}
		}
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	} catch (error) {
		const stale =
			error instanceof Error && /stale|revision/i.test(error.message);
		return reply(
			{
				error: stale
					? "설정이 바뀌었습니다. 새로 불러온 뒤 다시 시도해주세요."
					: "요청 내용을 확인해주세요.",
			},
			stale ? 409 : 400,
		);
	}
}

export async function enginePolicyRoutes(
	request: Request,
	store: EnginePolicySettingsStore,
	json: () => Promise<Record<string, unknown>>,
	managed?: () => import("../context/policy-settings.ts").EnginePolicySnapshot,
): Promise<Response | undefined> {
	if (new URL(request.url).pathname !== "/api/engines/policy") return;
	if (request.method === "GET")
		return reply(managed ? managed() : store.snapshot());
	if (managed)
		return reply({ error: "Engine policy is managed by the host" }, 409);
	if (request.method !== "PATCH")
		return reply({ error: "Method not allowed" }, 405);
	try {
		const body = await json();
		fields(body, ["expectedRevision", "settings"]);
		if (typeof body["expectedRevision"] !== "number")
			throw Error("invalid revision");
		return reply(
			store.replace(
				body["expectedRevision"],
				body["settings"] as EnginePolicyInput,
			),
		);
	} catch (error) {
		return reply(
			{ error: "Invalid or stale engine policy" },
			error instanceof Error && error.message.includes("stale") ? 409 : 400,
		);
	}
}
