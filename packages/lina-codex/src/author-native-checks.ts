import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	AUTHOR_DISABLED_FEATURES,
	type AuthorManagedFile,
	type AuthorNativePlan,
	authorRecord,
} from "./author-native-policy.ts";
import type { CodexRpc } from "./rpc.ts";

function emptyList(raw: unknown, field: string): unknown[] {
	const list = authorRecord(raw)[field];
	if (!Array.isArray(list))
		throw Error("Author capability inventory unavailable");
	return list;
}
function verifyManagedRequirements(files: readonly AuthorManagedFile[]): void {
	for (const file of files) {
		const policy = authorRecord(
			Bun.TOML.parse(readFileSync(file.source, "utf8")),
		);
		if (file.target.endsWith("/requirements.toml")) {
			for (const [key, required] of [
				["allowed_approval_policies", "never"],
				["allowed_sandbox_modes", "read-only"],
				["allowed_web_search_modes", "disabled"],
			] as const) {
				const allowed = policy[key];
				if (
					allowed != null &&
					(!Array.isArray(allowed) || !allowed.includes(required))
				)
					throw Error(
						"Administrator requirements conflict with author isolation",
					);
			}
		}
		if (file.target.endsWith("/managed_config.toml")) {
			if (
				(policy["approval_policy"] != null &&
					policy["approval_policy"] !== "never") ||
				(policy["sandbox_mode"] != null &&
					policy["sandbox_mode"] !== "read-only") ||
				(policy["web_search"] != null && policy["web_search"] !== "disabled") ||
				(policy["features"] != null &&
					AUTHOR_DISABLED_FEATURES.some(
						(key) => authorRecord(policy["features"])[key] === true,
					))
			)
				throw Error(
					"Administrator managed configuration conflicts with author isolation",
				);
		}
	}
}
export async function verifyAuthorNative(
	rpc: CodexRpc,
	plan: AuthorNativePlan,
): Promise<void> {
	// Older Codex may project the legacy managed config over requirements/read.
	// Check each preserved source as well as the native effective requirements.
	verifyManagedRequirements(plan.managed);
	const raw = authorRecord(
		await rpc.request("config/read", {
			includeLayers: true,
			cwd: plan.workspace,
		}),
	);
	const config = authorRecord(raw["config"]);
	const permissions = authorRecord(config["permissions"]);
	const profile = authorRecord(permissions["author"]);
	const fs = authorRecord(profile["filesystem"]);
	const network = authorRecord(profile["network"]);
	const features = authorRecord(config["features"]);
	const provider = authorRecord(
		authorRecord(config["model_providers"])["opencodex"],
	);
	if (
		config["model"] !== plan.selection.selected.model ||
		config["model_provider"] !== "opencodex" ||
		config["model_catalog_json"] !== join(plan.home, "models.json") ||
		provider["base_url"] !== plan.selection.connection.baseUrl ||
		provider["wire_api"] !== "responses" ||
		provider["requires_openai_auth"] !== false ||
		provider["supports_websockets"] !== false ||
		(plan.selection.connection.requiresAdmissionToken
			? provider["env_key"] !== "OPENCODEX_API_AUTH_TOKEN"
			: provider["env_key"] != null)
	)
		throw Error(
			"Effective author provider capability differs from its qualified selection",
		);
	if (
		config["approval_policy"] !== "never" ||
		config["default_permissions"] !== "author" ||
		config["web_search"] !== "disabled" ||
		profile["extends"] != null ||
		profile["workspace_roots"] != null ||
		network["enabled"] !== false ||
		fs[":minimal"] !== "read" ||
		fs[plan.workspace] !== "read" ||
		Object.entries(fs).some(
			([key, value]) =>
				value != null && key !== ":minimal" && key !== plan.workspace,
		) ||
		AUTHOR_DISABLED_FEATURES.some((key) => features[key] !== false) ||
		features["skip_host_skill_discovery"] !== true ||
		config["project_doc_max_bytes"] !== 0 ||
		authorRecord(config["agents"])["enabled"] !== false ||
		authorRecord(config["skills"])["include_instructions"] !== false ||
		authorRecord(authorRecord(config["skills"])["bundled"])["enabled"] !== false
	)
		throw Error(
			"Effective author native capability policy conflicts with requirements",
		);
	const requirements = authorRecord(
		await rpc.request("configRequirements/read", {}),
	)["requirements"];
	if (requirements != null) {
		const req = authorRecord(requirements);
		for (const [key, required] of [
			["allowedApprovalPolicies", "never"],
			["allowedSandboxModes", "read-only"],
			["allowedWebSearchModes", "disabled"],
		] as const) {
			const allowed = req[key];
			if (
				allowed != null &&
				(!Array.isArray(allowed) || !allowed.includes(required))
			)
				throw Error(
					"Administrator requirements conflict with author isolation",
				);
		}
	}
	const skills = emptyList(
		await rpc.request("skills/list", {
			cwds: [plan.workspace],
			forceReload: true,
		}),
		"data",
	);
	if (
		skills.some(
			(item) =>
				emptyList(item, "skills").length > 0 ||
				emptyList(item, "errors").length > 0,
		)
	)
		throw Error("Author native skills must be empty");
	const mcp = await rpc.request("mcpServerStatus/list", {});
	if (emptyList(mcp, "data").length || authorRecord(mcp)["nextCursor"] != null)
		throw Error("Author native MCP must be empty");
}
export function verifyAuthorThread(
	value: unknown,
	plan: AuthorNativePlan,
): void {
	const response = authorRecord(value);
	const profile = authorRecord(response["activePermissionProfile"]);
	if (
		profile["id"] !== "author" ||
		profile["extends"] != null ||
		response["approvalPolicy"] !== "never" ||
		response["cwd"] !== plan.workspace ||
		response["model"] !== plan.selection.selected.model ||
		response["modelProvider"] !== "opencodex" ||
		emptyList(response, "runtimeWorkspaceRoots").some(
			(root) => root !== plan.workspace,
		) ||
		emptyList(response, "instructionSources").length
	)
		throw Error(
			"Native thread did not select the qualified author capability profile",
		);
}

export function assertAuthorFiles(
	plan: AuthorNativePlan,
	config: string,
): void {
	if (
		realpathSync(plan.root) !== plan.root ||
		realpathSync(plan.home) !== plan.home ||
		realpathSync(plan.workspace) !== plan.workspace ||
		lstatSync(join(plan.home, "config.toml")).isSymbolicLink() ||
		lstatSync(join(plan.home, "models.json")).isSymbolicLink() ||
		readFileSync(join(plan.home, "config.toml"), "utf8") !== config ||
		readFileSync(join(plan.home, "models.json"), "utf8") !==
			JSON.stringify({ models: [plan.metadata] }) ||
		["skills", "plugins", "AGENTS.md", "auth.json", "managed_config.toml"].some(
			(p) => existsSync(join(plan.home, p)),
		)
	)
		throw Error("Author native config fingerprint changed");
}
