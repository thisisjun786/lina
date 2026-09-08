import type {
	AvatarApplyInput,
	GeneratedAvatarCandidate,
	VisualGrant,
	VisualInput,
} from "../../../lina-core/src/agents/visual.ts";
import { visualDigest } from "../../../lina-core/src/agents/visual-validation.ts";
import type { AvatarAssets } from "./avatar-assets.ts";
import type { AgentFleet } from "./manager.ts";

export type GeneratedAvatarApplicationChecker = (
	candidate: GeneratedAvatarCandidate,
) => boolean;

const headers = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};
const reply = (value: unknown, status = 200) =>
	Response.json(value, { status, headers });
const invalid = (): never => {
	throw Error("Invalid visual request");
};
const agentId = (value: string) => {
	if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) invalid();
	return value;
};
const revision = (value: unknown) => {
	if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1)
		invalid();
	return value as number;
};
const fieldId = (value: unknown, label: string) => {
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)
	)
		throw Error(`Invalid ${label}`);
	return value;
};
const requiredBoolean = (value: unknown): boolean => {
	if (typeof value !== "boolean") invalid();
	return value as boolean;
};
export const visualReferenceId = (agentId: string, requestKey: string) =>
	`reference-${visualDigest({ agentId, requestKey })}`;
const exact = (value: Record<string, unknown>, fields: string[]) => {
	if (
		Object.keys(value).length !== fields.length ||
		Object.keys(value).some((key) => !fields.includes(key))
	)
		invalid();
};
const headerRevision = (request: Request, name: string) => {
	const value = Number(request.headers.get(name));
	if (!Number.isSafeInteger(value) || value < 1) invalid();
	return value;
};
async function binary(request: Request): Promise<Uint8Array> {
	const max = 2 * 1024 * 1024;
	if (Number(request.headers.get("content-length")) > max) invalid();
	const stream = request.body?.getReader();
	if (!stream) throw Error("Invalid visual request");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await stream.read();
			if (next.done) return Buffer.concat(chunks);
			size += next.value.length;
			if (size > max) invalid();
			chunks.push(next.value);
		}
	} finally {
		void stream.cancel().catch(() => {});
	}
}

export async function agentVisualRoutes(
	request: Request,
	fleet: AgentFleet,
	assets: AvatarAssets,
	generatedApplication: GeneratedAvatarApplicationChecker,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const match =
		/^\/api\/agents\/([a-z][a-z0-9-]{0,47})\/visual(?:\/(references|history|pin|apply|restore))?$/.exec(
			url.pathname,
		);
	if (!match) return;
	if (request.headers.has("origin") || url.search)
		return reply({ error: "Forbidden" }, 403);
	const id = agentId(match[1] ?? ""),
		action = match[2];
	if (!fleet.agents.get(id)) return reply({ error: "Agent not found" }, 404);
	if (!action && request.method === "GET")
		return reply(fleet.agents.visual(id));
	if (!action && request.method === "PUT") {
		const input = await json();
		if ("visual" in input) {
			exact(input, ["expectedRevision", "visual"]);
			return reply(
				fleet.agents.updateVisual(
					id,
					revision(input["expectedRevision"]),
					input["visual"] as VisualInput,
				),
			);
		}
		exact(input, ["expectedRevision", "grant"]);
		return reply(
			fleet.agents.putVisualGrant(
				id,
				revision(input["expectedRevision"]),
				input["grant"] as VisualGrant,
			),
		);
	}
	if (action === "history" && request.method === "GET")
		return reply(fleet.agents.avatarHistory(id));
	if (action === "references" && request.method === "POST") {
		const requestKey = fieldId(
			request.headers.get("X-Lina-Request-Key"),
			"reference request key",
		);
		const filename = request.headers.get("X-Lina-Filename") ?? "";
		if (!filename || filename.length > 255) invalid();
		const bytes = await binary(request);
		const expectedProfileRevision = headerRevision(
			request,
			"X-Lina-Profile-Revision",
		);
		const expectedVisualRevision = headerRevision(
			request,
			"X-Lina-Visual-Revision",
		);
		const assetId = visualReferenceId(id, requestKey);
		const asset = assets.referenceAsset(bytes, filename);
		const candidate = {
			version: 1 as const,
			id: assetId,
			agentId: id,
			assetId,
			sha256: asset.sha256,
			mime: asset.mime,
			size: asset.size,
			origin: { kind: "upload" as const },
		};
		const existing = fleet.agents.visualReference(id, assetId);
		if (existing) {
			if (visualDigest(existing) !== visualDigest(candidate))
				throw Error("visual reference replay conflict");
			assets.writeReference(id, assetId, asset, bytes);
			return reply(existing);
		}
		const reference = fleet.agents.registerVisualReference(
			id,
			expectedProfileRevision,
			expectedVisualRevision,
			candidate,
		);
		// Missing bytes after this point remain charged; a same-key retry repairs them.
		assets.writeReference(id, assetId, asset, bytes);
		return reply(reference, 201);
	}
	if (action === "pin" && request.method === "POST") {
		const input = await json();
		exact(input, ["requestKey", "expectedRevision", "pinned"]);
		return reply(
			fleet.agents.setAvatarPinned(id, {
				requestKey: fieldId(input["requestKey"], "request key"),
				expectedRevision: revision(input["expectedRevision"]),
				pinned: requiredBoolean(input["pinned"]),
			}),
		);
	}
	if (
		(action === "apply" || action === "restore") &&
		request.method === "POST"
	) {
		const input = await json();
		exact(input, [
			"requestKey",
			"candidateId",
			"expectedProfileRevision",
			"expectedVisualRevision",
		]);
		const apply: AvatarApplyInput = {
			requestKey: fieldId(input["requestKey"], "request key"),
			candidateId: fieldId(input["candidateId"], "candidate id"),
			expectedProfileRevision: revision(input["expectedProfileRevision"]),
			expectedVisualRevision: revision(input["expectedVisualRevision"]),
			mode: action === "apply" ? "manual" : "restore",
		};
		return reply(
			fleet.agents.applyAvatarOnce(id, apply, {
				kind: "owner",
				validateCandidate: (candidate) => generatedApplication(candidate),
			}),
		);
	}
	return reply({ error: "Method not allowed" }, 405);
}
