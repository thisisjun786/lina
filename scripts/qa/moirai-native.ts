/** Opt-in synthetic R0 experiment. Artifacts stay outside the repository. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	verifyAuthorNative,
	verifyAuthorThread,
} from "../../packages/lina-codex/src/author-native-checks.ts";
import {
	AUTHOR_PROFILE,
	type AuthorNativePlan,
	authorConfig,
	authorFingerprint,
	authorManagedFiles,
	authorSelection,
	nativeExecutable,
} from "../../packages/lina-codex/src/author-native-policy.ts";
import { lifeWrite } from "../../packages/lina-codex/src/life-model-journal.ts";
import { lifeRpcOptions } from "../../packages/lina-codex/src/life-model-policy.ts";
import {
	MOIRAI_ROLES,
	MoiraiProbe,
	moiraiInstructions,
} from "../../packages/lina-codex/src/moirai-probe.ts";
import { createMoiraiProbeGateway } from "../../packages/lina-codex/src/moirai-probe-gateway.ts";
import { PROBE_REQUEST_OPTIONS } from "../../packages/lina-codex/src/moirai-probe-transport.ts";
import {
	type CodexRpc,
	createCodexRpc,
} from "../../packages/lina-codex/src/rpc.ts";
import {
	lifeMetadata,
	lifeResponse,
} from "../../packages/lina-codex/test/life-model-fixture.ts";
import {
	type IsolatedHomeConnection,
	OpenCodexHub,
} from "../../packages/lina-opencodex/src/hub.ts";
import {
	probeEvidenceRoot,
	probeExecutableIdentity,
	probeFingerprint,
	probeShutdown,
	probeSourceIdentity,
} from "./moirai-native-lifecycle.ts";

const live = process.argv.includes("--live");
const rootArg = process.argv.find((x) => x.startsWith("--root="))?.slice(7);
if (!rootArg)
	throw Error(
		"Usage: bun scripts/qa/moirai-native.ts --root=/absolute/new/evidence/path [--live]",
	);
const root = probeEvidenceRoot(rootArg, resolve(import.meta.dir, "../.."));
mkdirSync(root, { mode: 0o700 });
for (const name of ["native", "ledger", "wire"])
	mkdirSync(join(root, name), { mode: 0o700 });
const nativeRoot = join(root, "native");
const home = join(nativeRoot, "home"),
	workspace = join(nativeRoot, "workspace");
mkdirSync(home, { mode: 0o700 });
mkdirSync(workspace, { mode: 0o700 });
let fixture: ReturnType<typeof Bun.serve> | undefined;
let connection: IsolatedHomeConnection;
let credential: string | undefined;
let model: string;
if (live) {
	const hub = new OpenCodexHub();
	await hub.refresh();
	const found = hub.isolatedHomeConnection();
	if (!found) throw Error("Configured hub unavailable");
	connection = found;
	credential = hub.childEnvironment()["OPENCODEX_API_AUTH_TOKEN"];
	model = "ollama-cloud/glm-5.3-flash";
	if (!hub.catalog().some((m) => m.id === model && m.authenticated))
		throw Error("Exact GLM model unavailable");
} else {
	fixture = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as Record<string, unknown>;
			const text = JSON.stringify(body["input"]);
			return lifeResponse(`synthetic result ${text.length}`);
		},
	});
	const catalogFile = process.argv
		.find((x) => x.startsWith("--catalog-fixture="))
		?.slice(18);
	const metadata = catalogFile
		? JSON.parse(readFileSync(catalogFile, "utf8")).models[0]
		: lifeMetadata;
	model = metadata.slug;
	connection = {
		origin: fixture.url.origin,
		baseUrl: `${fixture.url.origin}/v1`,
		catalogJson: JSON.stringify({ models: [metadata] }),
		catalogSource: "hub",
		requiresAdmissionToken: false,
		tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
		providerTable: "",
	};
}
const gateway = createMoiraiProbeGateway({
	baseUrl: connection.baseUrl,
	...(credential ? { credential } : {}),
	model,
	...(live ? { responseModel: "glm-5.3-flash" } : {}),
	record: (key, value) => lifeWrite(join(root, "wire", `${key}.json`), value),
});
const selected = {
	id: "moirai-r0",
	provider: "opencodex",
	model,
	reasoning: "off" as const,
	maxOutputTokens: 4096,
};
const plan: AuthorNativePlan = {
	root: nativeRoot,
	home,
	workspace,
	command: nativeExecutable(
		join(homedir(), ".codex/packages/standalone/current/codex"),
	),
	wrapper: nativeExecutable("/usr/bin/bwrap"),
	selection: {
		selected,
		connection: {
			...connection,
			baseUrl: gateway.baseUrl,
			requiresAdmissionToken: true,
		},
	},
	metadata: authorSelection({ selected, connection }),
	managed: authorManagedFiles(),
	fingerprint: "",
};
// Match existing LIFE: isolated host, not provider metadata, owns tool exposure.
delete plan.metadata["tool_mode"];
plan.metadata["experimental_supported_tools"] = [];
delete plan.metadata["apply_patch_tool_type"];
plan.fingerprint = authorFingerprint(plan);
const sourceRoot = resolve(import.meta.dir, "../..");
const source = probeSourceIdentity(sourceRoot);
const requestOptions = {
	...PROBE_REQUEST_OPTIONS,
	max_output_tokens: 4096,
	tools: [],
	tool_choice: "none",
	stream: true,
};
const fingerprint = () => probeFingerprint(plan, sourceRoot, requestOptions);
const runtime = {
	capabilityFingerprint: plan.fingerprint,
	implementation: source,
	requestOptions,
	probeFingerprint: fingerprint(),
	command: probeExecutableIdentity(plan.command),
	wrapper: probeExecutableIdentity(plan.wrapper),
	bun: Bun.version,
	platform: process.platform,
	arch: process.arch,
};
lifeWrite(join(root, "runtime.json"), runtime);
writeFileSync(join(home, "config.toml"), authorConfig(plan), {
	mode: 0o600,
	flag: "wx",
});
writeFileSync(
	join(home, "models.json"),
	JSON.stringify({ models: [plan.metadata] }),
	{ mode: 0o600, flag: "wx" },
);
const runId = randomUUID();
let rpc: CodexRpc | undefined;
const results: unknown[] = [];
const shutdowns: Awaited<ReturnType<typeof probeShutdown>>[] = [];
const closeNative = async () => {
	if (!rpc) return;
	const receipt = await probeShutdown(rpc);
	shutdowns.push(receipt);
	rpc = undefined;
	lifeWrite(join(root, `shutdown-${shutdowns.length}.json`), receipt);
	if (!receipt.groupExited || receipt.closeError || receipt.observationError)
		throw Error("Owned native shutdown incomplete");
};
let status = "failed";
try {
	for (let round = 1; round <= 3; round++) {
		if (fingerprint() !== runtime.probeFingerprint)
			throw Error("Native capability changed during probe");
		rpc = await createCodexRpc(lifeRpcOptions(plan, gateway.nonce));
		await rpc.request("initialize", {
			clientInfo: { name: "moirai-r0", version: "1" },
			capabilities: { experimentalApi: true },
		});
		rpc.notify("initialized");
		await verifyAuthorNative(rpc, plan);
		const probe = new MoiraiProbe({
			rpc,
			root: join(root, "ledger"),
			model,
			gateway,
			threadParams: (role) => ({
				...AUTHOR_PROFILE,
				cwd: workspace,
				model,
				modelProvider: "opencodex",
				allowProviderModelFallback: false,
				personality: "none",
				developerInstructions: "",
				runtimeWorkspaceRoots: [],
				baseInstructions: moiraiInstructions(role),
			}),
			verifyThread: (raw) => verifyAuthorThread(raw, plan),
		});
		await probe.initialize();
		const input =
			round === 1
				? "We have a synthetic task: choose one way to organize three notes. The reference color is teal. Give one concise proposal with a reason. No tools."
				: `Round ${round}: revise the prior proposal for only two notes. Mention the earlier reference color if it is in your own history; do not guess. Give a concise answer. No tools.`;
		console.log(
			JSON.stringify({ event: "round-start", round, pid: rpc.pid, live }),
		);
		const pid = rpc.pid;
		const roundId = `r${round}-${runId}`;
		const output = await probe.round(
			roundId,
			input,
			new AbortController().signal,
			async () => {
				if (round === 2) {
					if (!pid) throw Error("Missing owned PID for kill check");
					process.kill(-pid, "SIGKILL");
				}
				await closeNative();
				if (round === 2)
					lifeWrite(join(root, "kill.json"), {
						pid,
						signal: "SIGKILL",
						boundary: "after canonical completed turns, before round2 commit",
						observedAt: Date.now(),
					});
			},
		);
		// Copy the validated snapshots after shutdown; no unguarded native reads.
		for (const role of MOIRAI_ROLES) {
			const history = JSON.parse(
				readFileSync(
					join(root, "ledger", `round-${roundId}`, `final-native-${role}.json`),
					"utf8",
				),
			);
			lifeWrite(join(root, `history-${round}-${role}.json`), history);
		}
		results.push({ round, pid, output });
		console.log(
			JSON.stringify({
				event: "round-complete",
				round,
				roles: output.map((x) => x.role),
			}),
		);
	}
	if (fingerprint() !== runtime.probeFingerprint)
		throw Error("Native capability changed during probe");
	status = "pass";
} catch (error) {
	results.push({
		error: error instanceof Error ? error.message : String(error),
	});
	process.exitCode = 1;
} finally {
	try {
		await closeNative();
	} catch (error) {
		status = "failed";
		process.exitCode = 1;
		results.push({
			error: error instanceof Error ? error.message : String(error),
		});
	}
	await gateway.close();
	await fixture?.stop(true);
	const result = {
		status,
		live,
		model,
		runId,
		runtime,
		results,
		limits: {
			callsPerEpisode: 6,
			outputTokensPerRequest: 4096,
			requestTimeoutMs: 120000,
		},
		scope: "R0 transport/history only, not qualification or cognitive utility",
		ownedProcessesClosed:
			shutdowns.length > 0 &&
			shutdowns.every(
				(receipt) =>
					receipt.groupExited &&
					!receipt.closeError &&
					!receipt.observationError,
			),
		shutdowns,
	};
	lifeWrite(join(root, "result.json"), result);
	console.log(JSON.stringify(result));
}
