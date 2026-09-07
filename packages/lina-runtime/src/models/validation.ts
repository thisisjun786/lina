import {
	MODEL_ROLES,
	type ModelProfile,
	type ModelReasoning,
	type ModelRole,
	type ModelSettingsInput,
	type RoleReasoning,
} from "./types.ts";

// Storage limits, not claims about a provider's supported capabilities.
const MAX_MODEL_NAME = 256;
const MAX_PROFILES = 256;
const MAX_AGENT_BINDINGS = 256;
const MAX_OUTPUT_TOKENS = 1_048_576;
const INPUT_KEYS = ["profiles", "defaultProfileId", "roles", "agentRoles"];
const OPTIONAL_INPUT_KEYS = ["roleReasoning", "agentRoleReasoning"];
const PROFILE_KEYS = ["id", "provider", "model", "reasoning"];
const OPTIONAL_PROFILE_KEYS = ["maxOutputTokens"];

function object(value: unknown, label: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null) ||
		Reflect.ownKeys(value).some((key) => typeof key !== "string")
	)
		throw new Error(`invalid ${label}`);
	// Narrow only after rejecting arrays, custom prototypes and symbol keys.
	return value as Record<string, unknown>;
}

/**
 * Required keys must all be present; optional keys may be absent entirely.
 * A present key always carries a validated value: "present but undefined"
 * is rejected like any other invalid value so JSON and object input agree.
 */
function exactFields(
	value: Record<string, unknown>,
	keys: string[],
	optional: string[],
	label: string,
): void {
	const names = Object.getOwnPropertyNames(value);
	if (
		keys.some((key) => !Object.hasOwn(value, key)) ||
		names.some((key) => !keys.includes(key) && !optional.includes(key))
	)
		throw new Error(`invalid or unknown ${label} fields`);
}

/** Profile IDs use the same safe slug grammar as fleet agent IDs. */
export function validModelId(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value))
		throw new Error(`invalid ${label}`);
	return value;
}

export function validModelRole(value: unknown): ModelRole {
	for (const role of MODEL_ROLES) if (role === value) return role;
	throw new Error("unknown model role");
}

export function validModelReasoning(value: unknown): ModelReasoning {
	if (
		value !== "off" &&
		value !== "low" &&
		value !== "medium" &&
		value !== "high"
	)
		throw new Error("invalid model reasoning");
	return value;
}

export function validSettingsRevision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("invalid model settings revision");
	return value;
}

function modelName(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > MAX_MODEL_NAME ||
		/\p{Cc}/u.test(value)
	)
		throw new Error(`invalid ${label}`);
	return value;
}

function outputBudget(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_OUTPUT_TOKENS
	)
		throw new Error("invalid model output budget");
	return value;
}

function profile(value: unknown): ModelProfile {
	const input = object(value, "model profile");
	exactFields(input, PROFILE_KEYS, OPTIONAL_PROFILE_KEYS, "model profile");
	const result: ModelProfile = {
		id: validModelId(input["id"], "profile id"),
		provider: modelName(input["provider"], "model provider"),
		model: modelName(input["model"], "model name"),
		reasoning: validModelReasoning(input["reasoning"]),
	};
	if (Object.hasOwn(input, "maxOutputTokens"))
		result.maxOutputTokens = outputBudget(input["maxOutputTokens"]);
	return result;
}

function reference(value: unknown, ids: Set<string>): string {
	const id = validModelId(value, "profile reference");
	if (!ids.has(id)) throw new Error("unknown model profile reference");
	return id;
}

function roleBindings(
	value: unknown,
	ids: Set<string>,
): Partial<Record<ModelRole, string>> {
	const bindings = object(value, "model roles");
	return Object.fromEntries(
		Object.getOwnPropertyNames(bindings).map((key) => [
			validModelRole(key),
			reference(bindings[key], ids),
		]),
	);
}

function roleReasoning(value: unknown): RoleReasoning {
	const map = object(value, "role reasoning");
	return Object.fromEntries(
		Object.getOwnPropertyNames(map).map((key) => [
			validModelRole(key),
			validModelReasoning(map[key]),
		]),
	);
}

function agentMap<T>(
	value: unknown,
	label: string,
	entry: (value: unknown) => T,
): Record<string, T> {
	const map = object(value, label);
	const agents = Object.getOwnPropertyNames(map);
	if (agents.length > MAX_AGENT_BINDINGS) throw new Error(`too many ${label}`);
	return Object.fromEntries(
		agents.map((id) => [validModelId(id, "agent id"), entry(map[id])]),
	);
}

/** Validates external input or persisted JSON and returns fully detached data. */
export function parseModelSettingsInput(value: unknown): ModelSettingsInput {
	const input = object(value, "model settings");
	exactFields(input, INPUT_KEYS, OPTIONAL_INPUT_KEYS, "model settings");
	const rawProfiles = input["profiles"];
	if (!Array.isArray(rawProfiles) || rawProfiles.length > MAX_PROFILES)
		throw new Error("invalid model profiles");
	const profiles = Array.from(rawProfiles, profile);
	const ids = new Set(profiles.map((item) => item.id));
	if (ids.size !== profiles.length)
		throw new Error("duplicate model profile id");
	const result: ModelSettingsInput = {
		profiles,
		defaultProfileId:
			input["defaultProfileId"] === null
				? null
				: reference(input["defaultProfileId"], ids),
		roles: roleBindings(input["roles"], ids),
		agentRoles: agentMap(input["agentRoles"], "agent role bindings", (v) =>
			roleBindings(v, ids),
		),
	};
	// Legacy JSON without these keys round-trips without gaining them.
	if (Object.hasOwn(input, "roleReasoning"))
		result.roleReasoning = roleReasoning(input["roleReasoning"]);
	if (Object.hasOwn(input, "agentRoleReasoning"))
		result.agentRoleReasoning = agentMap(
			input["agentRoleReasoning"],
			"agent reasoning bindings",
			roleReasoning,
		);
	return result;
}
