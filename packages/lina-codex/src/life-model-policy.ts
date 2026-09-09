import { homedir } from "node:os";
import { join } from "node:path";
import { parseLifeModelRequest } from "../../lina-core/src/world/autonomy-record-validation.ts";
import type { LifeModelRequest } from "../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import type { IsolatedHomeConnection } from "../../lina-opencodex/src/hub.ts";
import type { ModelProfile } from "../../lina-runtime/src/models/types.ts";
import {
	type AuthorNativePlan,
	authorConfig,
	authorFileDigest,
	authorFingerprint,
	authorHash,
	authorManagedFiles,
	authorRpcOptions,
	authorSelection,
	nativeExecutable,
} from "./author-native-policy.ts";
import type { CodexRpcOptions } from "./rpc.ts";

export function lifeRpcOptions(
	plan: AuthorNativePlan,
	nonce?: string,
): CodexRpcOptions {
	const options = authorRpcOptions(plan, nonce);
	const args = [...(options.args ?? [])];
	const boundary = args.lastIndexOf("--");
	if (boundary < 0) throw Error("Missing LIFE wrapper command boundary");
	// Keep the owned bind writable while forbidding writes into ancestor tmpfs paths.
	args.splice(boundary, 0, "--remount-ro", "/");
	return { ...options, args };
}

export interface CodexLifeModelOptions {
	stateRoot: string;
	selection(request: LifeModelRequest): {
		connection: IsolatedHomeConnection;
		selected: ModelProfile;
		settingsRevision: number;
	};
	/** Synchronous final authorization on a cloned request; throw to prevent outbound I/O. */
	beforeOutbound?(request: LifeModelRequest): void;
	providerEnv?: () => Record<string, string | undefined>;
	command?: string;
	wrapperCommand?: string;
}
export function lifePlan(
	options: CodexLifeModelOptions,
	request: LifeModelRequest,
): AuthorNativePlan {
	if (process.platform !== "linux")
		throw Error("LIFE native isolation requires Linux");
	const selection = structuredClone(
		options.selection(structuredClone(request)),
	);
	if (
		selection.selected.provider !== request.provider ||
		selection.selected.model !== request.model ||
		selection.settingsRevision !== request.modelSettingsRevision
	)
		throw Error("LIFE exact model/settings selection changed");
	if (request.version === 3) {
		parseLifeModelRequest(request);
		const exact = {
			profileId: selection.selected.id,
			provider: selection.selected.provider,
			model: selection.selected.model,
			reasoning: selection.selected.reasoning,
			maxOutputTokens: selection.selected.maxOutputTokens ?? null,
			settingsRevision: selection.settingsRevision,
		};
		if (lifeDigest(exact) !== request.selection.routeFingerprint)
			throw Error("LIFE frozen selection changed before native preparation");
	}

	const metadata = { ...authorSelection(selection) };
	// Tool exposure belongs to the isolated LIFE host, not provider metadata.
	// Preserve model capabilities; the synthetic catalog gate still qualifies output.
	delete metadata["tool_mode"];
	if (
		typeof metadata["context_window"] !== "number" ||
		!Number.isSafeInteger(metadata["context_window"]) ||
		metadata["context_window"] <= 0
	)
		throw Error("LIFE requires exact model context metadata");
	const partial = {
		root: "/LIFE_NATIVE",
		home: "/LIFE_NATIVE/home",
		workspace: "/LIFE_NATIVE/workspace",
		command: nativeExecutable(
			options.command ??
				join(homedir(), ".codex/packages/standalone/current/codex"),
		),
		wrapper: nativeExecutable(options.wrapperCommand ?? "/usr/bin/bwrap"),
		selection,
		metadata,
		managed: authorManagedFiles(),
	};
	const fingerprint = authorHash(
		JSON.stringify({
			version: request.version === 3 ? 2 : 1,
			...(request.version === 3
				? { resolvedSelection: request.selection }
				: {}),
			author: authorFingerprint(partial),
			settingsRevision: selection.settingsRevision,
			implementation: [
				"life-model.ts",
				"life-model-policy.ts",
				"life-model-native.ts",
				"life-model-gateway.ts",
				"life-model-journal.ts",
				"life-model-validation.ts",
				"life-model-qualification.ts",
				"rpc.ts",
				"model.ts",
				"../../lina-core/src/world/autonomy-record-validation.ts",
				"../../lina-core/src/world/life-json.ts",
				"../../lina-core/src/world/validation.ts",
				"../../lina-core/src/world/authoring-node-validation.ts",
				"../../lina-core/src/attachments/filesystem.ts",
			].map((p) => authorFileDigest(join(import.meta.dir, p))),
			config: authorConfig({
				...partial,
				selection: {
					...selection,
					connection: {
						...selection.connection,
						baseUrl: "http://127.0.0.1:0/v1",
						requiresAdmissionToken: true,
					},
				},
			}),
			dynamicTools: [],
		}),
	);
	return { ...partial, fingerprint };
}
