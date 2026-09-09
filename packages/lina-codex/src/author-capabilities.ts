import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	checkedDirectory,
	checkedRegular,
} from "../../lina-core/src/attachments/filesystem.ts";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type { SessionContextPolicy } from "../../lina-runtime/src/context-policy.ts";
import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import type { SessionEngine } from "../../lina-runtime/src/session-engine.ts";
import {
	assertAuthorFiles,
	verifyAuthorNative,
	verifyAuthorThread,
} from "./author-native-checks.ts";
import {
	AUTHOR_PROFILE,
	AUTHOR_TOOLS,
	type AuthorNativePlan,
	type AuthorNativeSelection,
	authorConfig,
	authorFingerprint,
	authorManagedFiles,
	authorRpcOptions,
	authorSelection,
	authorSelectionDigest,
	nativeExecutable,
} from "./author-native-policy.ts";
import { qualifyAuthorNative } from "./author-qualification.ts";
import {
	initializeCodexSessionFile,
	inspectCodexSessionFile,
	loadCodexJournal,
	readCodexSessionHeader,
} from "./identity.ts";
import {
	type ConversationTurnModel,
	nativeEffort,
	requireListedModel,
} from "./model.ts";
import type { CodexRpc } from "./rpc.ts";
import { type CodexSessionOptions, createCodexSession } from "./session.ts";

export type WorldAuthorEngineOptions = AuthorNativeSelection & {
	nativeRoot: string;
	grantId: string;
	agentId: string;
	worldId: string;
	models: ModelControl;
	currentSelection: () => AuthorNativeSelection;
	providerEnv?: Readonly<Record<string, string | undefined>>;
	/** Must be the installed native executable, not a shell/JS launcher. */
	command?: string;
	wrapperCommand?: string;
};
export type WorldAuthorEngine = {
	engine: SessionEngine;
	capabilityPolicyDigest: string;
	workspace: string;
};

type AuthorCapability = {
	assert(): void;
	preflight(rpc: CodexRpc): Promise<void>;
	threadParams: typeof AUTHOR_PROFILE;
	verifyThread(value: unknown): void;
	bindTools(names: readonly string[]): void;
	allowsTool(name: string): boolean;
	model(catalog: unknown): ConversationTurnModel;
};
// The exact options object is the capability. Callers cannot mint one with a flag,
// copied properties, a permission-profile string, or a forged receipt on disk.
const authorized = new WeakMap<SdkSessionOptions, AuthorCapability>();
export function worldAuthorCapability(
	options: SdkSessionOptions,
): AuthorCapability | undefined {
	const capability = authorized.get(options);
	if (options.contextPolicy?.purpose === "world-author" && !capability)
		throw Error("World-author requires a qualified author capability factory");
	if (capability) capability.assert();
	return capability;
}

function authorServices(metadata: Record<string, unknown>): ContextServices {
	const window = metadata["context_window"];
	if (
		typeof window !== "number" ||
		!Number.isSafeInteger(window) ||
		window <= 0
	)
		throw Error("Invalid author model context window");
	return {
		estimateText: (text) => Math.ceil(text.length / 4),
		estimateMessages: (messages) =>
			Math.ceil(JSON.stringify(messages).length / 4),
		systemTokens: 0,
		contextWindow: window,
		reserveTokens: 0,
		summarize: async () => {
			throw Error("Author sessions do not use ordinary memory summarization");
		},
		prepare: () => {
			throw Error("Author sessions do not use ordinary context preparation");
		},
	};
}
function outside(root: string, path: string): boolean {
	const part = relative(root, resolve(path));
	return part === ".." || part.startsWith("../");
}

/** No real model turn is submitted during creation or qualification. */
export async function createWorldAuthorEngine(
	input: WorldAuthorEngineOptions,
): Promise<WorldAuthorEngine> {
	if (process.platform !== "linux")
		throw Error("Qualified author isolation is only available on Linux");
	for (const id of [input.grantId, input.agentId, input.worldId])
		if (
			!id ||
			id.length > 256 ||
			id.trim() !== id ||
			[...id].some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			)
		)
			throw Error("Invalid author capability identity");
	const commandInput =
		input.command ??
		join(homedir(), ".codex/packages/standalone/current/codex");
	const wrapperInput = input.wrapperCommand ?? "/usr/bin/bwrap";
	const command = nativeExecutable(commandInput),
		wrapper = nativeExecutable(wrapperInput);
	const selection: AuthorNativeSelection = structuredClone({
		connection: input.connection,
		selected: input.selected,
	});
	const metadata = { ...authorSelection(selection) };
	// The qualified author host owns its tool surface, independently of the provider.
	delete metadata["tool_mode"];
	if (
		authorSelectionDigest(input.currentSelection()) !==
		authorSelectionDigest(selection)
	)
		throw Error("Author model selection changed before qualification");
	const root = checkedDirectory(input.nativeRoot, true);
	const ownerFile = join(root, "author-owner.json");
	const owner = JSON.stringify({
		version: 1,
		grantId: input.grantId,
		agentId: input.agentId,
		worldId: input.worldId,
	});
	if (!existsSync(ownerFile)) {
		if (readdirSync(root).length)
			throw Error("Author native root must be empty and grant-owned");
		writeFileSync(ownerFile, owner, { flag: "wx", mode: 0o600 });
	} else {
		checkedRegular(ownerFile);
		if (readFileSync(ownerFile, "utf8") !== owner)
			throw Error("Author native root belongs to another grant");
	}
	const home = checkedDirectory(join(root, "codex-home"), true),
		workspace = checkedDirectory(join(root, "workspace"), true);
	const partial = {
		root,
		home,
		workspace,
		command,
		wrapper,
		selection,
		metadata,
		managed: authorManagedFiles(),
	};
	const plan: AuthorNativePlan = {
		...partial,
		fingerprint: authorFingerprint(partial),
	};
	const config = authorConfig(plan);
	for (const [name, value] of [
		["config.toml", config],
		["models.json", JSON.stringify({ models: [metadata] })],
	] as const) {
		const path = join(home, name);
		if (!existsSync(path))
			writeFileSync(path, value, { mode: 0o600, flag: "wx" });
		else {
			checkedRegular(path);
			// Retain an old root for inspection. A changed selection requires a fresh
			// root/context rather than overwriting the native configuration in place.
			if (readFileSync(path, "utf8") !== value)
				throw Error(
					"Author native config changed; a fresh isolated context is required",
				);
		}
	}
	const token = input.providerEnv?.["OPENCODEX_API_AUTH_TOKEN"];
	if (selection.connection.requiresAdmissionToken && !token)
		throw Error("Author provider admission token is unavailable");
	const assert = () => {
		if (
			nativeExecutable(commandInput) !== command ||
			nativeExecutable(wrapperInput) !== wrapper ||
			authorSelectionDigest(input.currentSelection()) !==
				authorSelectionDigest(selection) ||
			authorFingerprint({ ...plan, managed: authorManagedFiles() }) !==
				plan.fingerprint
		)
			throw Error(
				"Author capability fingerprint changed; qualification and a fresh context are required",
			);
		checkedRegular(ownerFile);
		if (readFileSync(ownerFile, "utf8") !== owner)
			throw Error("Author native root ownership changed");
		assertAuthorFiles(plan, config);
	};
	const receipt = await qualifyAuthorNative(plan);
	assert();
	const receipts = checkedDirectory(join(root, "qualification"), true);
	const receiptFile = join(receipts, `${plan.fingerprint}.json`);
	checkedRegular(receiptFile, false);
	writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
	const services = authorServices(metadata);
	const matchesPolicy = (policy: SessionContextPolicy | null | undefined) =>
		policy?.purpose === "world-author" &&
		policy.capabilityPolicyDigest === plan.fingerprint &&
		policy.authorGrantId === input.grantId &&
		policy.agentId === input.agentId &&
		policy.worldId === input.worldId;
	const assertJournal = (file: string) => {
		if (!outside(root, file))
			throw Error("Author context journal must stay outside its native root");
		if (!existsSync(file) || statSync(file).size === 0) return;
		const header = readCodexSessionHeader(file, workspace);
		if (matchesPolicy(header.contextPolicy)) return;
		const journal = loadCodexJournal(file);
		// initialize() may have prepared the first author epoch without starting a
		// native process. No prior native binding or ordinary history may be adopted.
		if (
			header.nativeEpoch === 0 &&
			!header.contextPolicy &&
			matchesPolicy(header.contextTransition?.target) &&
			journal.length === 1
		) {
			const entry = journal[0];
			if (
				entry &&
				typeof entry === "object" &&
				"type" in entry &&
				entry.type === "context_transition" &&
				"prior" in entry &&
				entry.prior &&
				typeof entry.prior === "object" &&
				"nativeThreadId" in entry.prior &&
				entry.prior.nativeThreadId === null &&
				"contextPolicy" in entry.prior &&
				entry.prior.contextPolicy === null
			)
				return;
		}
		throw Error("Cannot reuse a weaker native author context");
	};
	let active = false;
	const engine: SessionEngine = {
		kind: "codex",
		inspect: inspectCodexSessionFile,
		initialize(file, cwd, policy) {
			assert();
			if (resolve(cwd) !== workspace || !matchesPolicy(policy))
				throw Error(
					"Author context does not match its qualified grant capability",
				);
			assertJournal(file);
			return initializeCodexSessionFile(file, cwd, policy);
		},
		async create(options) {
			assert();
			if (active)
				throw Error("Author native engine already has an active session");
			const policy = options.contextPolicy;
			if (
				policy?.purpose !== "world-author" ||
				policy.capabilityPolicyDigest !== plan.fingerprint ||
				policy.authorGrantId !== input.grantId ||
				policy.agentId !== input.agentId ||
				policy.worldId !== input.worldId ||
				resolve(options.workspace) !== workspace ||
				!outside(root, options.sessionFile)
			)
				throw Error(
					"Author context does not match its qualified grant capability",
				);
			assertJournal(options.sessionFile);
			const sessionOptions: CodexSessionOptions = {
				...options,
				services,
				models: input.models,
				rpc: authorRpcOptions(plan, token),
				skillRoots: [],
				model: selection.selected.model,
				modelProvider: "opencodex",
			};
			// Explicit fields above win over any runtime object-spread extras.
			delete sessionOptions.rpcClient;
			const boundTools = new Set<string>();
			const capability: AuthorCapability = {
				assert() {
					assert();
					const current = options.currentContextPolicy?.();
					if (
						current?.purpose !== "world-author" ||
						current.authorGrantId !== input.grantId ||
						current.agentId !== input.agentId ||
						current.worldId !== input.worldId ||
						current.capabilityPolicyDigest !== plan.fingerprint
					)
						throw Error("Author grant capability changed");
				},
				preflight: (rpc) => verifyAuthorNative(rpc, plan),
				threadParams: AUTHOR_PROFILE,
				verifyThread: (value) => verifyAuthorThread(value, plan),
				bindTools(names) {
					for (const name of names) {
						if (!AUTHOR_TOOLS.includes(name))
							throw Error("Tool is outside the author capability allowlist");
						boundTools.add(name);
					}
				},
				allowsTool: (name) => boundTools.has(name),
				model(catalog) {
					capability.assert();
					requireListedModel(catalog, selection.selected.model);
					const effort = nativeEffort(
						catalog,
						selection.selected.model,
						selection.selected.reasoning,
					);
					return {
						model: selection.selected.model,
						modelProvider: "opencodex",
						...(effort ? { effort } : {}),
					};
				},
			};
			authorized.set(sessionOptions, capability);
			active = true;
			try {
				const session = await createCodexSession(sessionOptions);
				const close = session.close.bind(session);
				session.close = async () => {
					try {
						await close();
					} finally {
						active = false;
						authorized.delete(sessionOptions);
					}
				};
				return session;
			} catch (error) {
				active = false;
				authorized.delete(sessionOptions);
				throw error;
			}
		},
	};
	return { engine, capabilityPolicyDigest: plan.fingerprint, workspace };
}
