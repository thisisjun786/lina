import {
	parseSourcePolicy,
	type SourceMaterialKind,
	type SourcePolicy,
} from "./source-policy.ts";

export interface SourceRequestOrigin {
	version: 1;
	purpose: "conversation" | "life" | "world-author";
	sessionId: string;
	requestId: string;
	nativeEpoch: number;
	scopeDigest: string;
	contextReceiptIds: string[];
}
/** Transport-owned receipt, structurally shared with the runtime context seam. */
export interface SourceExposure {
	type: "context_exposure";
	version: 1;
	id: string;
	nativeEpoch: number;
	scopeDigest: string;
	source:
		| Readonly<{ kind: "bootstrap" | "turn"; requestId: string }>
		| Readonly<{
				kind: "tool";
				requestId: string;
				toolName: string;
				callId: string;
		  }>;
	materials: readonly Readonly<{
		kind: SourceMaterialKind;
		sourceId: string;
	}>[];
	outcome: "planned" | "delivered";
}
function invalid(): never {
	throw Error("Invalid source origin");
}
function fields(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const object = value as Record<string, unknown>;
	if (
		Object.keys(object).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(object, key))
	)
		invalid();
	return object;
}
function id(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 256 ||
		value.trim() !== value ||
		[...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
		invalid();
	return value;
}
export function parseSourceOrigin(value: unknown): SourceRequestOrigin {
	const input = fields(value, [
		"version",
		"purpose",
		"sessionId",
		"requestId",
		"nativeEpoch",
		"scopeDigest",
		"contextReceiptIds",
	]);
	const purpose = input["purpose"];
	if (
		purpose !== "conversation" &&
		purpose !== "life" &&
		purpose !== "world-author"
	)
		invalid();
	const {
		scope: _scope,
		policyRevision: _revision,
		materialKinds: _kinds,
		...common
	} = parseSourcePolicy({
		version: input["version"],
		scope: "ordinary",
		sessionId: input["sessionId"],
		requestId: input["requestId"],
		nativeEpoch: input["nativeEpoch"],
		scopeDigest: input["scopeDigest"],
		contextReceiptIds: input["contextReceiptIds"],
		policyRevision: 1,
		materialKinds: [],
	});
	return { ...common, purpose };
}
export function parseSourceExposure(value: unknown): SourceExposure {
	const input = fields(value, [
		"type",
		"version",
		"id",
		"nativeEpoch",
		"scopeDigest",
		"source",
		"materials",
		"outcome",
	]);
	if (
		input["type"] !== "context_exposure" ||
		input["version"] !== 1 ||
		(input["outcome"] !== "planned" && input["outcome"] !== "delivered")
	)
		invalid();
	const rawSource = input["source"];
	if (!rawSource || typeof rawSource !== "object") invalid();
	const tool = "kind" in rawSource && rawSource.kind === "tool";
	const source = fields(
		rawSource,
		tool ? ["kind", "requestId", "toolName", "callId"] : ["kind", "requestId"],
	);
	const kind = source["kind"];
	if (kind !== "bootstrap" && kind !== "turn" && kind !== "tool") invalid();
	const parsedSource: SourceExposure["source"] =
		kind === "tool"
			? {
					kind,
					requestId: id(source["requestId"]),
					toolName: id(source["toolName"]),
					callId: id(source["callId"]),
				}
			: { kind, requestId: id(source["requestId"]) };
	if (!Array.isArray(input["materials"]) || input["materials"].length > 256)
		invalid();
	const materials = input["materials"].map(
		(item: unknown): SourceExposure["materials"][number] => {
			const material = fields(item, ["kind", "sourceId"]),
				kind = material["kind"];
			if (
				kind !== "shared-growth" &&
				kind !== "disclosed-life" &&
				kind !== "author-world"
			)
				invalid();
			return { kind, sourceId: id(material["sourceId"]) };
		},
	);
	const parsed = parseSourcePolicy({
		version: 1,
		scope: "mixed",
		sessionId: "validation",
		requestId: parsedSource.requestId,
		nativeEpoch: input["nativeEpoch"],
		scopeDigest: input["scopeDigest"],
		policyRevision: 1,
		contextReceiptIds: [id(input["id"])],
		materialKinds: [...new Set(materials.map((material) => material.kind))],
	});
	return {
		type: "context_exposure",
		version: 1,
		id: id(input["id"]),
		nativeEpoch: parsed.nativeEpoch,
		scopeDigest: parsed.scopeDigest,
		source: parsedSource,
		materials,
		outcome: input["outcome"],
	};
}
export function sourcePolicyFor(
	origin: SourceRequestOrigin,
	receipts: readonly SourceExposure[],
	policyRevision: number,
): SourcePolicy {
	if (
		receipts.length !== origin.contextReceiptIds.length ||
		new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length
	)
		invalid();
	for (const receipt of receipts) {
		if (
			!origin.contextReceiptIds.includes(receipt.id) ||
			receipt.nativeEpoch !== origin.nativeEpoch ||
			receipt.scopeDigest !== origin.scopeDigest
		)
			invalid();
	}
	const materialKinds = [
		...new Set(
			receipts.flatMap((receipt) =>
				receipt.materials.map((material) => material.kind),
			),
		),
	];
	const scope =
		origin.purpose !== "conversation"
			? "life"
			: materialKinds.some((kind) => kind !== "shared-growth")
				? "mixed"
				: "ordinary";
	const { purpose: _purpose, ...common } = origin;
	return parseSourcePolicy({ ...common, scope, policyRevision, materialKinds });
}
