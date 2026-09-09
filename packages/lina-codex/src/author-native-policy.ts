import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IsolatedHomeConnection } from "../../lina-opencodex/src/hub.ts";
import type { ModelProfile } from "../../lina-runtime/src/models/types.ts";
import type { CodexRpcOptions } from "./rpc.ts";

export const AUTHOR_TOOLS = Object.freeze([
	"lina_world_draft_read",
	"lina_world_draft_preview",
	"lina_life_config_read",
	"lina_world_draft_create",
	"lina_world_draft_edit",
	"lina_world_draft_suggest",
	"lina_world_draft_confirm",
	"lina_life_config_update",
]);
export const AUTHOR_DISABLED_FEATURES = Object.freeze([
	"shell_tool",
	"unified_exec",
	"shell_snapshot",
	"apps",
	"plugins",
	"remote_plugin",
	"hooks",
	"memories",
	"multi_agent",
	"multi_agent_v2",
	"browser_use",
	"browser_use_external",
	"browser_use_full_cdp_access",
	"computer_use",
	"in_app_browser",
	"image_generation",
	"view_image",
	"code_mode",
	"code_mode_host",
	"workspace_dependencies",
	"skill_search",
	"skill_mcp_dependency_install",
	"tool_suggest",
	"sleep_tool",
	"recommended_plugins",
	"goals",
	"default_mode_request_user_input",
]);
export const AUTHOR_PROFILE = Object.freeze({
	permissions: "author",
	approvalPolicy: "never",
	environments: Object.freeze([]),
	selectedCapabilityRoots: Object.freeze([]),
});
export const AUTHOR_MANAGED_PATHS = Object.freeze([
	"/etc/codex/requirements.toml",
	"/etc/codex/managed_config.toml",
	"/etc/codex/config.toml",
]);
export type AuthorManagedFile = {
	source: string;
	target: string;
	digest: string;
};
export type AuthorNativeSelection = {
	connection: IsolatedHomeConnection;
	selected: ModelProfile;
};
export type AuthorNativePlan = {
	root: string;
	workspace: string;
	home: string;
	command: string;
	wrapper: string;
	managed: readonly AuthorManagedFile[];
	selection: AuthorNativeSelection;
	metadata: Record<string, unknown>;
	fingerprint: string;
};
export function authorHash(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
const fileDigests = new Map<string, { stamp: string; digest: string }>();
function fileStamp(path: string): string {
	const stat = statSync(path, { bigint: true });
	if (!stat.isFile()) throw Error("Author fingerprint requires a regular file");
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
/** Keep per-notification guards cheap without treating an old checksum as current. */
export function authorFileDigest(path: string): string {
	const stamp = fileStamp(path);
	const cached = fileDigests.get(path);
	if (cached?.stamp === stamp) return cached.digest;
	const digest = authorHash(readFileSync(path));
	if (fileStamp(path) !== stamp)
		throw Error("Native capability file changed while fingerprinting");
	fileDigests.set(path, { stamp, digest });
	return digest;
}
export function authorRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Invalid author capability response");
	return value as Record<string, unknown>;
}
export function nativeExecutable(command: string): string {
	const path = realpathSync(Bun.which(command) ?? resolve(command));
	const fd = openSync(path, "r"),
		magic = Buffer.alloc(4);
	try {
		if (
			!statSync(path).isFile() ||
			readSync(fd, magic, 0, 4, 0) !== 4 ||
			!magic.equals(Buffer.from([127, 69, 76, 70]))
		)
			throw Error(
				"Author isolation requires an exact native Linux executable, not a launcher",
			);
	} finally {
		closeSync(fd);
	}
	return path;
}

/** Paths are fixed in the factory. Explicit synthetic paths are for policy qualification. */
export function authorManagedFiles(
	paths: readonly string[] = AUTHOR_MANAGED_PATHS,
): AuthorManagedFile[] {
	return paths.flatMap((source, index) => {
		if (!lstatSync(source, { throwIfNoEntry: false })) return [];
		if (!statSync(source).isFile())
			throw Error("Invalid administrator-managed Codex policy");
		const target = AUTHOR_MANAGED_PATHS[index];
		if (!target) throw Error("Unknown administrator-managed Codex policy");
		return [
			{
				source: realpathSync(source),
				target,
				digest: authorHash(readFileSync(source)),
			},
		];
	});
}
export function authorSelection(
	selection: AuthorNativeSelection,
): Record<string, unknown> {
	if (
		selection.selected.provider !== "opencodex" ||
		!selection.selected.model ||
		!selection.connection.catalogJson
	)
		throw Error("Author requires exact selected OpenCodex model metadata");
	const catalog = authorRecord(JSON.parse(selection.connection.catalogJson));
	if (!Array.isArray(catalog["models"]))
		throw Error("Author model catalog is unavailable");
	const matches = catalog["models"].filter(
		(m: unknown) => authorRecord(m)["slug"] === selection.selected.model,
	);
	if (matches.length !== 1)
		throw Error("Author requires one exact selected native model");
	const url = new URL(selection.connection.baseUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw Error("Invalid author provider transport");
	return authorRecord(matches[0]);
}
export function authorSelectionDigest(
	selection: AuthorNativeSelection,
): string {
	return authorHash(
		JSON.stringify({
			selected: selection.selected,
			metadata: authorSelection(selection),
			baseUrl: selection.connection.baseUrl,
			requiresAdmissionToken: selection.connection.requiresAdmissionToken,
		}),
	);
}

export function authorConfig(
	plan: Pick<AuthorNativePlan, "home" | "workspace" | "selection">,
	baseUrl = plan.selection.connection.baseUrl,
	synthetic = false,
): string {
	const q = JSON.stringify;
	return `model = ${q(plan.selection.selected.model)}
model_provider = "opencodex"
model_catalog_json = ${q(join(plan.home, "models.json"))}
project_doc_max_bytes = 0
web_search = "disabled"
default_permissions = "author"
approval_policy = "never"
[permissions.author.filesystem]
":minimal" = "read"
${q(plan.workspace)} = "read"
[permissions.author.network]
enabled = false
[agents]
enabled = false
[skills]
include_instructions = false
[skills.bundled]
enabled = false
[tools.experimental_request_user_input]
enabled = false
[features]
${AUTHOR_DISABLED_FEATURES.map((f) => `${f} = false`).join("\n")}
skip_host_skill_discovery = true
[model_providers.opencodex]
name = "Author model transport"
base_url = ${q(baseUrl)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 5000
${!synthetic && plan.selection.connection.requiresAdmissionToken ? 'env_key = "OPENCODEX_API_AUTH_TOKEN"\n' : ""}`;
}

export function authorRpcOptions(
	plan: AuthorNativePlan,
	token?: string,
): CodexRpcOptions {
	// --clearenv closes createCodexRpc's ambient-env merge, including variables added later.
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--clearenv",
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--dir",
		homedir(),
	];
	for (const path of [
		"/etc/passwd",
		"/etc/group",
		"/etc/resolv.conf",
		"/etc/hosts",
		"/etc/ssl",
	])
		if (existsSync(path)) args.push("--ro-bind", path, path);
	// Never hide existing system policy. Codex also reads/enforces it inside the namespace.
	for (const policy of plan.managed)
		args.push("--ro-bind", policy.source, policy.target);
	args.push(
		"--ro-bind",
		plan.command,
		"/opt/codex",
		"--bind",
		plan.root,
		plan.root,
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--setenv",
		"LANG",
		"C.UTF-8",
		"--setenv",
		"HOME",
		homedir(),
		"--setenv",
		"CODEX_HOME",
		plan.home,
	);
	if (token) args.push("--setenv", "OPENCODEX_API_AUTH_TOKEN", token);
	args.push(
		"--chdir",
		plan.workspace,
		"--",
		"/opt/codex",
		"app-server",
		"--stdio",
		"--strict-config",
	);
	const env: Record<string, string | undefined> = Object.fromEntries(
		Object.keys(process.env).map((k) => [k, undefined]),
	);
	// The wrapper itself must not load ambient libraries or startup hooks either.
	env["PATH"] = "/usr/bin:/bin";
	env["LANG"] = "C.UTF-8";
	return {
		command: plan.wrapper,
		args,
		env,
		cwd: plan.workspace,
		timeoutMs: 10000,
	};
}

export function authorFingerprint(
	plan: Omit<AuthorNativePlan, "fingerprint">,
): string {
	return authorHash(
		JSON.stringify({
			version: 1,
			platform: process.platform,
			arch: process.arch,
			command: authorFileDigest(plan.command),
			wrapper: authorFileDigest(plan.wrapper),
			selection: authorSelectionDigest(plan.selection),
			managed: plan.managed.map((p) => [p.target, p.digest]),
			// The source fingerprint also invalidates receipts when qualification or guards change.
			implementation: [
				"author-native-policy.ts",
				"author-native-checks.ts",
				"author-qualification.ts",
				"author-capabilities.ts",
				"session.ts",
				"context-policy.ts",
			].map((p) => authorFileDigest(join(import.meta.dir, p))),
			config: authorConfig({
				...plan,
				home: "/AUTHOR_HOME",
				workspace: "/AUTHOR_WORK",
			}),
			tools: AUTHOR_TOOLS,
		}),
	);
}
