import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createSessionContextPolicy,
	type SessionContextMaterial,
} from "../../lina-runtime/src/context-policy.ts";
import { worldServices } from "../../lina-runtime/test/world-fixture.ts";
import { CodexContextPolicy } from "../src/context-policy.ts";
import { initializeCodexSessionFile } from "../src/identity.ts";
import { createCodexEngine, createCodexSession } from "../src/session.ts";
import { contextRpc } from "./context-policy-rpc.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(purpose: "conversation" | "life" | "world-author") {
	const root = mkdtempSync(join(tmpdir(), "lina-author-context-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const policy = createSessionContextPolicy({
		purpose,
		version: purpose === "world-author" ? 2 : 1,
		agentId: "mina",
		worldId: "island",
		bindingRevision: 1,
		disclosureRevision: 1,
		sourcePolicyVersion: 1,
		...(purpose === "world-author"
			? { authorGrantId: "grant-1", capabilityPolicyDigest: "a".repeat(64) }
			: {}),
	});
	const rpc = contextRpc(root);
	cleanup.push(() => rpc.close());
	const options = {
		workspace: root,
		sessionFile: join(root, "session.jsonl"),
		agentDir: root,
		systemPrompt: "base",
		contextPolicy: policy,
		currentContextPolicy: () => policy,
		contextExposure: (): readonly SessionContextMaterial[] => [],
		services: worldServices(),
		models: {
			catalog: () => [],
			state: () => ({
				provider: "synthetic",
				model: "synthetic/companion-dialogue",
				settingsRevision: 1,
				error: null,
			}),
			test: async () => {
				throw Error("No provider");
			},
		},
		rpc: rpc.options,
	};
	return { root, policy, rpc, options };
}

test("ordinary engine and direct session cannot construct author-purpose native context", async () => {
	const f = fixture("world-author");
	for (const create of [
		() => createCodexSession(f.options),
		() => createCodexEngine(f.options).create(f.options),
	]) {
		const opened = create();
		void opened.then(
			(s) => cleanup.push(() => s.close()),
			() => {},
		);
		await expect(opened).rejects.toThrow(
			/qualified.*author|author.*capability/i,
		);
	}
	expect(f.rpc.frames).toHaveLength(0);
});

for (const purpose of ["conversation", "life"] as const)
	test(`${purpose} refuses author material before bootstrap transport`, async () => {
		const f = fixture(purpose);
		const opened = createCodexSession({
			...f.options,
			contextExposure: () => [
				{ kind: "author-world", sourceId: "secret-draft" },
			],
		});
		void opened.then(
			(s) => cleanup.push(() => s.close()),
			() => {},
		);
		await expect(opened).rejects.toThrow(/material.*not allowed/i);
		expect(f.rpc.frames.some((frame) => frame.method === "thread/start")).toBe(
			false,
		);
	});

test("author material is recorded with author scope and other purpose changes fail closed", () => {
	const f = fixture("world-author");
	let current = f.policy;
	const identity = initializeCodexSessionFile(
		f.options.sessionFile,
		f.root,
		f.policy,
	);
	const context = new CodexContextPolicy(
		{
			...f.options,
			currentContextPolicy: () => current,
			contextExposure: () => [{ kind: "author-world", sourceId: "draft:1" }],
		},
		identity.sessionFile,
		f.root,
	);
	const receipt = context.plan(
		{ kind: "bootstrap", requestId: "r1" },
		f.policy,
		1,
	);
	expect(receipt?.materials).toEqual([
		{ kind: "author-world", sourceId: "draft:1" },
	]);
	current = createSessionContextPolicy({
		purpose: "life",
		version: 1,
		agentId: "mina",
		worldId: "island",
		bindingRevision: 1,
		disclosureRevision: 1,
		sourcePolicyVersion: 1,
	});
	expect(() => context.current()).toThrow(/purpose|author/i);
});
