import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkedDirectory } from "../../lina-core/src/attachments/filesystem.ts";
import { verifyAuthorNative } from "../src/author-native-checks.ts";
import {
	type AuthorNativePlan,
	authorConfig,
	authorManagedFiles,
	authorRpcOptions,
	nativeExecutable,
} from "../src/author-native-policy.ts";
import { createCodexRpc } from "../src/rpc.ts";

// Explicit local native qualification; ordinary CI needs no Codex/Bubblewrap install.
const nativeTest =
	process.env["LINA_AUTHOR_NATIVE_TEST"] === "1" ? test : test.skip;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
test("an administrator policy symlink that cannot be resolved is a failure, not an absent policy", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-author-policy-link-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "requirements.toml");
	symlinkSync(join(root, "missing-policy"), source);
	expect(() => authorManagedFiles([source])).toThrow();
});
function fixture(requirements: string) {
	const base = mkdtempSync(join(tmpdir(), "lina-author-managed-"));
	cleanup.push(() => rmSync(base, { recursive: true, force: true }));
	const source = join(base, "requirements.toml"),
		managed = join(base, "managed_config.toml");
	writeFileSync(source, requirements);
	writeFileSync(managed, 'approval_policy = "never"\n');
	const root = checkedDirectory(join(base, "native"), true),
		home = checkedDirectory(join(root, "codex-home"), true),
		workspace = checkedDirectory(join(root, "workspace"), true);
	const metadata = {
		slug: "author-managed-probe",
		display_name: "Synthetic",
		description: "Synthetic",
		base_instructions: "Synthetic",
		supported_reasoning_levels: [],
		default_reasoning_level: null,
		shell_type: "unified_exec",
		priority: 0,
		support_verbosity: false,
		truncation_policy: { mode: "bytes", limit: 10000 },
		experimental_supported_tools: [],
		context_window: 32000,
		input_modalities: ["text"],
		visibility: "list",
		supported_in_api: true,
	};
	const plan: AuthorNativePlan = {
		root,
		home,
		workspace,
		command: nativeExecutable(
			join(homedir(), ".codex/packages/standalone/current/codex"),
		),
		wrapper: nativeExecutable("/usr/bin/bwrap"),
		managed: authorManagedFiles([source, managed]),
		selection: {
			selected: {
				id: "synthetic",
				provider: "opencodex",
				model: metadata.slug,
				reasoning: "off",
			},
			connection: {
				origin: "http://127.0.0.1:1",
				baseUrl: "http://127.0.0.1:1/v1",
				catalogJson: JSON.stringify({ models: [metadata] }),
				catalogSource: "hub",
				requiresAdmissionToken: false,
				tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
				providerTable: "",
			},
		},
		metadata,
		fingerprint: "synthetic-managed-policy",
	};
	writeFileSync(join(home, "config.toml"), authorConfig(plan));
	writeFileSync(
		join(home, "models.json"),
		JSON.stringify({ models: [metadata] }),
	);
	return { plan, source, requirements, managed };
}

nativeTest(
	"existing administrator requirements and managed config remain visible read-only in author isolation",
	async () => {
		const f = fixture(
			'allowed_approval_policies = ["never"]\nallowed_sandbox_modes = ["read-only"]\nallowed_web_search_modes = ["disabled"]\n',
		);
		const options = authorRpcOptions(f.plan);
		for (const file of f.plan.managed) {
			const source = options.args?.indexOf(file.source) ?? -1;
			expect(options.args?.[source - 1]).toBe("--ro-bind");
			expect(options.args?.[source + 1]).toBe(file.target);
		}
		const rpc = await createCodexRpc(options);
		cleanup.push(() => rpc.close());
		await rpc.request("initialize", {
			clientInfo: { name: "author-managed-policy-test", version: "1" },
			capabilities: { experimentalApi: true },
		});
		rpc.notify("initialized");
		await verifyAuthorNative(rpc, f.plan);
		const result = await rpc.request<{
			requirements: { allowedApprovalPolicies: string[] };
		}>("configRequirements/read", {});
		expect(result.requirements.allowedApprovalPolicies).toEqual(["never"]);
		expect(readFileSync(f.source, "utf8")).toBe(f.requirements);
		expect(readFileSync(f.managed, "utf8")).toBe('approval_policy = "never"\n');
	},
	15000,
);

nativeTest(
	"conflicting administrator approval requirements reject native author startup without bypass",
	async () => {
		const f = fixture('allowed_approval_policies = ["on-request"]\n');
		const rpc = await createCodexRpc(authorRpcOptions(f.plan));
		cleanup.push(() => rpc.close());
		const check = async () => {
			await rpc.request("initialize", {
				clientInfo: { name: "author-conflicting-policy-test", version: "1" },
				capabilities: { experimentalApi: true },
			});
			rpc.notify("initialized");
			await verifyAuthorNative(rpc, f.plan);
		};
		await expect(check()).rejects.toThrow();
		expect(readFileSync(f.source, "utf8")).toBe(f.requirements);
	},
	15000,
);
