import { type Static, type TSchema, Type } from "typebox";
import type { WorldAuthorGrant } from "../../../lina-core/src/world/authoring-types.ts";
import type { LinaTool, LinaToolResult } from "../host.ts";
import type { WorldAuthoring } from "./authoring.ts";

const identifier = Type.String({ minLength: 1, maxLength: 256 });
const revision = Type.Integer({ minimum: 0 });
const object = <T extends Record<string, TSchema>>(fields: T) =>
	Type.Object(fields, { additionalProperties: false });

/** This registration is called only by the dedicated author composition. */
export function createWorldAuthorTools(
	service: WorldAuthoring,
	grant: WorldAuthorGrant,
): LinaTool[] {
	const scope = { grantId: grant.id, grantRevision: grant.revision };
	service.assertScope(scope);
	function tool<T extends TSchema>(
		name: string,
		description: string,
		parameters: T,
		execute: (
			input: Static<T>,
			signal: AbortSignal,
		) => unknown | Promise<unknown>,
	): LinaTool<T> {
		return {
			name,
			label: description,
			description,
			parameters,
			async execute(_callId, input, signal): Promise<LinaToolResult> {
				if (!signal) throw Error("Author tool signal is required");
				signal.throwIfAborted();
				service.assertScope(scope);
				const result = await execute(input, signal);
				signal.throwIfAborted();
				service.assertScope(scope);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
				};
			},
		};
	}
	return [
		tool(
			"lina_world_draft_read",
			'Read this author world. Start with {"query":"overview"} to discover draft IDs/revisions, current confirmed version and modelSettingsRevision. Page with afterId/limit (1-32). Use {"draftId":"..."} for a draft, or {"query":"pack"} for the current confirmed pack; add version for history.',
			Type.Union([
				object({ draftId: identifier }),
				object({
					query: Type.Literal("overview"),
					afterId: Type.Optional(Type.Union([identifier, Type.Null()])),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
				}),
				object({
					query: Type.Literal("pack"),
					version: Type.Optional(Type.Integer({ minimum: 1 })),
				}),
			]),
			(input) => {
				if ("draftId" in input) return service.read(input.draftId, scope);
				if (input.query === "pack")
					return service.pack(grant.worldId, input.version, scope);
				return service.overview(
					{ afterId: input.afterId ?? null, limit: input.limit ?? 16 },
					scope,
				);
			},
		),
		tool(
			"lina_world_draft_preview",
			"Preview an exact draft revision without activation",
			object({
				draftId: identifier,
				expectedRevision: revision,
				options: Type.Unknown(),
			}),
			(input) =>
				service.preview(
					input.draftId,
					input.expectedRevision,
					input.options,
					scope,
				),
		),
		tool(
			"lina_life_config_read",
			"Read authored operational configuration and missing values",
			object({}),
			() => service.config(grant.worldId, scope),
		),
		tool(
			"lina_world_draft_create",
			"Create a draft from explicitly authored text",
			object({ authoredText: Type.String({ minLength: 1, maxLength: 24000 }) }),
			(input) =>
				service.create(
					{ worldId: grant.worldId, authoredText: input.authoredText },
					scope,
				),
		),
		tool(
			"lina_world_draft_edit",
			"Replace an exact draft revision",
			object({
				draftId: identifier,
				expectedRevision: revision,
				patch: Type.Unknown(),
			}),
			(input) =>
				service.edit(input.draftId, input.expectedRevision, input.patch, scope),
		),
		tool(
			"lina_world_draft_suggest",
			"Request one model suggestion with a durable request key",
			object({
				requestId: identifier,
				draftId: identifier,
				draftRevision: revision,
				modelSettingsRevision: revision,
			}),
			(input, signal) =>
				service.suggest({ ...input, agentId: grant.agentId }, signal, scope),
		),
		tool(
			"lina_world_draft_confirm",
			"Confirm the exact draft, preview digest, and simulation boundary",
			object({ confirmation: Type.Unknown() }),
			(input) => service.confirm(input.confirmation, scope),
		),
		tool(
			"lina_life_config_update",
			"Replace operational configuration without starting a scheduler",
			object({ expectedRevision: revision, config: Type.Unknown() }),
			(input) =>
				service.setConfig(
					grant.worldId,
					input.expectedRevision,
					input.config,
					scope,
				),
		),
	];
}
