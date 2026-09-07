import { createHash } from "node:crypto";

/** Authorization identity; ordinary world progress is deliberately not part of it. */
export type SessionContextPolicy = Readonly<{
	purpose: "conversation" | "life";
	version: 1;
	agentId: string;
	worldId: string | null;
	bindingRevision: number;
	disclosureRevision: number;
	sourcePolicyVersion: number;
	scopeDigest: string;
}>;
export type SessionContextSource =
	| Readonly<{ kind: "bootstrap"; requestId: string }>
	| Readonly<{ kind: "turn"; requestId: string }>
	| Readonly<{
			kind: "tool";
			requestId: string;
			toolName: string;
			callId: string;
	  }>;
export type SessionContextMaterial = Readonly<{
	kind: "shared-growth" | "disclosed-life";
	sourceId: string;
}>;
export type SessionContextExposure = Readonly<{
	type: "context_exposure";
	version: 1;
	id: string;
	nativeEpoch: number;
	scopeDigest: string;
	source: SessionContextSource;
	materials: readonly SessionContextMaterial[];
	/** Planned intent remains exposed when transport acknowledgement is unknown. */
	outcome: "planned" | "delivered";
}>;

const FIELDS = [
	"purpose",
	"version",
	"agentId",
	"worldId",
	"bindingRevision",
	"disclosureRevision",
	"sourcePolicyVersion",
];
function invalid(): never {
	throw new Error("Invalid session context policy");
}
function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		invalid();
	return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		[...value].every(
			(character) =>
				character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
		)
	);
}
function revision(value: unknown, minimum = 0): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}
function fields(
	value: Record<string, unknown>,
): Omit<SessionContextPolicy, "scopeDigest"> {
	const {
		purpose,
		version,
		agentId,
		worldId,
		bindingRevision,
		disclosureRevision,
		sourcePolicyVersion,
	} = value;
	if (
		(purpose !== "conversation" && purpose !== "life") ||
		version !== 1 ||
		!identifier(agentId) ||
		(worldId !== null && !identifier(worldId)) ||
		(purpose === "life" && worldId === null) ||
		!revision(bindingRevision) ||
		!revision(disclosureRevision) ||
		!revision(sourcePolicyVersion, 1)
	)
		invalid();
	return {
		purpose,
		version,
		agentId,
		worldId,
		bindingRevision,
		disclosureRevision,
		sourcePolicyVersion,
	};
}
function digest(value: Omit<SessionContextPolicy, "scopeDigest">): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function createSessionContextPolicy(
	value: unknown,
): SessionContextPolicy {
	const input = record(value);
	if (
		Object.keys(input).length !== FIELDS.length ||
		Object.keys(input).some((k) => !FIELDS.includes(k))
	)
		invalid();
	const parsed = fields(input);
	return Object.freeze({ ...parsed, scopeDigest: digest(parsed) });
}
export function parseSessionContextPolicy(
	value: unknown,
): SessionContextPolicy {
	const input = record(value);
	if (
		Object.keys(input).length !== FIELDS.length + 1 ||
		Object.keys(input).some((k) => k !== "scopeDigest" && !FIELDS.includes(k))
	)
		invalid();
	const parsed = fields(input);
	if (input["scopeDigest"] !== digest(parsed)) invalid();
	return Object.freeze({ ...parsed, scopeDigest: digest(parsed) });
}

/** Only trusted runtime selection may call this; never parse model result text. */
export function parseSessionContextMaterials(
	value: unknown,
): readonly SessionContextMaterial[] {
	if (!Array.isArray(value) || value.length > 256) invalid();
	return Object.freeze(
		value.map((item) => {
			const input = record(item);
			const { kind, sourceId } = input;
			if (
				Object.keys(input).length !== 2 ||
				(kind !== "shared-growth" && kind !== "disclosed-life") ||
				!identifier(sourceId)
			)
				invalid();
			return Object.freeze({ kind, sourceId });
		}),
	);
}
export function parseSessionContextExposure(
	value: unknown,
): SessionContextExposure {
	const input = record(value);
	const { type, version, id, nativeEpoch, scopeDigest, outcome } = input;
	if (
		Object.keys(input).length !== 8 ||
		type !== "context_exposure" ||
		version !== 1 ||
		!identifier(id) ||
		!revision(nativeEpoch, 1) ||
		typeof scopeDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(scopeDigest) ||
		(outcome !== "planned" && outcome !== "delivered")
	)
		invalid();
	const rawSource = record(input["source"]);
	const { kind, requestId, toolName, callId } = rawSource;
	if (!identifier(requestId)) invalid();
	let source: SessionContextSource;
	if (kind === "tool") {
		if (
			Object.keys(rawSource).length !== 4 ||
			!identifier(toolName) ||
			!identifier(callId)
		)
			invalid();
		source = { kind, requestId, toolName, callId };
	} else {
		if (
			Object.keys(rawSource).length !== 2 ||
			(kind !== "turn" && kind !== "bootstrap")
		)
			invalid();
		source = { kind, requestId };
	}
	return Object.freeze({
		type,
		version,
		id,
		nativeEpoch,
		scopeDigest,
		outcome,
		source: Object.freeze(source),
		materials: parseSessionContextMaterials(input["materials"]),
	});
}
