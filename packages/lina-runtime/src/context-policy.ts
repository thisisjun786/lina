import { createHash } from "node:crypto";

/** Authorization identity; ordinary world progress is deliberately not part of it. */
type ContextPolicyFields = Readonly<{
	agentId: string;
	worldId: string | null;
	bindingRevision: number;
	disclosureRevision: number;
	sourcePolicyVersion: number;
	scopeDigest: string;
}>;
export type SessionContextPolicy = ContextPolicyFields &
	(
		| Readonly<{ purpose: "conversation" | "life"; version: 1 }>
		| Readonly<{
				purpose: "conversation";
				version: 3;
				conversationRecipientId: string | null;
		  }>
		| Readonly<{
				purpose: "world-author";
				version: 2;
				worldId: string;
				authorGrantId: string;
				capabilityPolicyDigest: string;
		  }>
	);
type UnsignedPolicy = SessionContextPolicy extends infer P
	? P extends SessionContextPolicy
		? Omit<P, "scopeDigest">
		: never
	: never;
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
	kind: "shared-growth" | "disclosed-life" | "author-world";
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
const AUTHOR_FIELDS = [...FIELDS, "authorGrantId", "capabilityPolicyDigest"];
const CONVERSATION_FIELDS = [...FIELDS, "conversationRecipientId"];
function policyFields(input: Record<string, unknown>): readonly string[] {
	if (input["version"] === 3 && input["purpose"] === "conversation")
		return CONVERSATION_FIELDS;
	return input["version"] === 2 && input["purpose"] === "world-author"
		? AUTHOR_FIELDS
		: FIELDS;
}
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
function fields(value: Record<string, unknown>): UnsignedPolicy {
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
		!(
			(version === 1 && (purpose === "conversation" || purpose === "life")) ||
			(version === 2 && purpose === "world-author") ||
			(version === 3 && purpose === "conversation")
		) ||
		!identifier(agentId) ||
		(worldId !== null && !identifier(worldId)) ||
		(purpose !== "conversation" && worldId === null) ||
		!revision(bindingRevision) ||
		!revision(disclosureRevision) ||
		!revision(sourcePolicyVersion, 1)
	)
		invalid();
	const common = {
		purpose,
		version,
		agentId,
		worldId,
		bindingRevision,
		disclosureRevision,
		sourcePolicyVersion,
	};
	if (version === 3 && purpose === "conversation") {
		const conversationRecipientId = value["conversationRecipientId"];
		if (
			(conversationRecipientId !== null &&
				!identifier(conversationRecipientId)) ||
			(worldId === null &&
				(conversationRecipientId !== null ||
					bindingRevision !== 0 ||
					disclosureRevision !== 0)) ||
			sourcePolicyVersion !== 1
		)
			invalid();
		return { ...common, purpose, version, conversationRecipientId };
	}
	if (purpose === "world-author" && version === 2 && worldId !== null) {
		const { authorGrantId, capabilityPolicyDigest } = value;
		if (
			!identifier(authorGrantId) ||
			typeof capabilityPolicyDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(capabilityPolicyDigest)
		)
			invalid();
		return {
			...common,
			purpose,
			version,
			worldId,
			authorGrantId,
			capabilityPolicyDigest,
		};
	}
	if (version !== 1 || (purpose !== "conversation" && purpose !== "life"))
		invalid();
	return { ...common, purpose, version };
}
function digest(value: UnsignedPolicy): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function createSessionContextPolicy(
	value: unknown,
): SessionContextPolicy {
	const input = record(value);
	const allowed = policyFields(input);
	if (
		Object.keys(input).length !== allowed.length ||
		Object.keys(input).some((k) => !allowed.includes(k))
	)
		invalid();
	const parsed = fields(input);
	return Object.freeze({ ...parsed, scopeDigest: digest(parsed) });
}
export function parseSessionContextPolicy(
	value: unknown,
): SessionContextPolicy {
	const input = record(value);
	const allowed = policyFields(input);
	if (
		Object.keys(input).length !== allowed.length + 1 ||
		Object.keys(input).some((k) => k !== "scopeDigest" && !allowed.includes(k))
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
				(kind !== "shared-growth" &&
					kind !== "disclosed-life" &&
					kind !== "author-world") ||
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
