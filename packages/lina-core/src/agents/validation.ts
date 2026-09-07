import type { AgentInput, Dynamics, ReflectionInput } from "./types.ts";

export const MAX_AGENTS = 16;
export const MAX_TEXT = 1000;
export const MAX_PROFILE = 1200;
export const MAX_APPEARANCE = 3000;
export const MAX_VOICE = 1600;
export const MAX_PERSONALITY = 1400;
export const MAX_ITEM = 160;
export const MAX_ITEMS = 16;
export const MAX_ID = 160;
export const MOOD_TTL_MS = 4 * 60 * 60 * 1000;

const profileKeys = new Set([
	"id",
	"name",
	"role",
	"personality",
	"voice",
	"profile",
	"appearance",
	"interests",
	"avatarId",
	"evolution",
]);
const patchKeys = new Set([...profileKeys].filter((key) => key !== "id"));
const reflectionKeys = new Set([
	"profileRevision",
	"dynamicsRevision",
	"requestId",
	"sourceEntryIds",
	"mood",
	"interests",
	"preferences",
	"relationship",
]);

function object(
	value: unknown,
	keys: Set<string>,
	label: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`invalid ${label}`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result))
		if (!keys.has(key)) throw new Error(`unknown ${label} field ${key}`);
	return result;
}

export function boundedText(
	value: unknown,
	label: string,
	max = MAX_TEXT,
): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > max ||
		value.includes("\u0000")
	)
		throw new Error(`invalid ${label}`);
	return value;
}

export function boundedId(value: unknown, label: string): string {
	return boundedText(value, label, MAX_ID);
}

export function boundedList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS)
		throw new Error(`invalid ${label}`);
	const result = value.map((item) =>
		boundedText(item, `${label} item`, MAX_ITEM),
	);
	if (new Set(result).size !== result.length)
		throw new Error(`${label} must be unique`);
	return result;
}

export function validateAgentInput(value: unknown): AgentInput {
	const input = object(value, profileKeys, "agent");
	if (Object.keys(input).length !== profileKeys.size)
		throw new Error("invalid agent fields");
	return {
		id: boundedId(input["id"], "agent id"),
		name: boundedText(input["name"], "agent name"),
		role: boundedText(input["role"], "agent role"),
		personality: boundedText(
			input["personality"],
			"agent personality",
			MAX_PERSONALITY,
		),
		voice: boundedText(input["voice"], "agent voice", MAX_VOICE),
		profile: boundedText(input["profile"], "agent profile", MAX_PROFILE),
		appearance: boundedText(
			input["appearance"],
			"agent appearance",
			MAX_APPEARANCE,
		),
		interests: boundedList(input["interests"], "agent interests"),
		avatarId:
			input["avatarId"] === null
				? null
				: (() => {
						const id = boundedId(input["avatarId"], "avatar id");
						if (!/^[0-9a-f]{64}$/i.test(id))
							throw new Error("invalid avatar id");
						return id;
					})(),
		evolution:
			input["evolution"] === "adaptive" || input["evolution"] === "manual"
				? input["evolution"]
				: (() => {
						throw new Error("invalid evolution");
					})(),
	};
}

export function validatePatch(value: unknown): Partial<Omit<AgentInput, "id">> {
	const patch = object(value, patchKeys, "agent patch");
	for (const key of Object.keys(patch)) {
		if (key === "interests") boundedList(patch[key], "agent interests");
		else if (key === "avatarId") {
			if (patch[key] !== null) {
				const id = boundedId(patch[key], "avatar id");
				if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error("invalid avatar id");
			}
		} else if (key === "evolution") {
			if (patch[key] !== "adaptive" && patch[key] !== "manual")
				throw new Error("invalid evolution");
		} else
			boundedText(
				patch[key],
				`agent ${key}`,
				key === "profile"
					? MAX_PROFILE
					: key === "appearance"
						? MAX_APPEARANCE
						: key === "voice"
							? MAX_VOICE
							: key === "personality"
								? MAX_PERSONALITY
								: MAX_TEXT,
			);
	}
	return patch as Partial<Omit<AgentInput, "id">>;
}

export function validateReflection(value: unknown): ReflectionInput {
	const input = object(value, reflectionKeys, "reflection");
	if (
		!Number.isSafeInteger(input["profileRevision"]) ||
		(input["profileRevision"] as number) < 1 ||
		!Number.isSafeInteger(input["dynamicsRevision"]) ||
		(input["dynamicsRevision"] as number) < 0
	)
		throw new Error("invalid reflection revision");
	const result: ReflectionInput = {
		profileRevision: input["profileRevision"] as number,
		dynamicsRevision: input["dynamicsRevision"] as number,
		requestId: boundedId(input["requestId"], "request id"),
		sourceEntryIds: boundedList(input["sourceEntryIds"], "source entry ids"),
	};
	if (result.sourceEntryIds.length === 0)
		throw new Error("reflection requires a source");
	for (const key of ["interests", "preferences", "relationship"] as const)
		if (key in input) result[key] = boundedList(input[key], key);
	if ("mood" in input) {
		const mood = object(input["mood"], new Set(["label", "reason"]), "mood");
		if (Object.keys(mood).length !== 2) throw new Error("invalid mood fields");
		result.mood = {
			label: boundedText(mood["label"], "mood label", MAX_ITEM),
			reason: boundedText(mood["reason"], "mood reason", MAX_ITEM),
		};
	}
	return result;
}

export function emptyDynamics(): Dynamics {
	return {
		revision: 0,
		mood: null,
		interests: [],
		preferences: [],
		relationship: [],
		lastRequestId: null,
	};
}
