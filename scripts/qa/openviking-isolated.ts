import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	OpenVikingClient,
	OpenVikingRequestError,
} from "../../packages/lina-memory/src/openviking/index.ts";

const LIVE_PORT = 1933;
const LIVE_WORKSPACE = join(homedir(), ".local/share/openviking/data");
const LIVE_CONF = join(homedir(), ".openviking/ov.conf");
const PINNED_SOURCE =
	process.env["LINA_QA_OPENVIKING_SOURCE"] ??
	join(homedir(), "tmp/OpenViking-v0.4.17.1");
const VENV_PYTHON =
	process.env["LINA_QA_OPENVIKING_PYTHON"] ??
	join(homedir(), ".local/share/openviking/venv/bin/python");
const ROOT_URI = "viking://resources/lina-isolated-qa";
const NOTE_URI = "notes.md";
const HERE = dirname(fileURLToPath(import.meta.url));
const EVIDENCE = join(
	mkdtempSync(join(tmpdir(), "lina-openviking-evidence-")),
	"evidence.json",
);
const RUNTIME_SCRIPT = join(HERE, "openviking-isolated-runtime.py");

type ReadyInfo = {
	baseUrl: string;
	apiKey: string;
	rootUri: string;
	workspace: string;
	configPath: string;
	pid: number;
	port: number;
	version: string;
	packagePath: string;
	authMode: string;
	modelStub: string;
};

const records: unknown[] = [];
const digest = (text: string) =>
	createHash("sha256").update(text).digest("hex");

function record(step: string, value: Record<string, unknown>): void {
	records.push({ step, ...value });
}

async function listening(port: number, host = "127.0.0.1"): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = createConnection({ host, port });
		socket.once("connect", () => {
			socket.end();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.setTimeout(400, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function liveHealth(): Promise<Record<string, unknown>> {
	try {
		const response = await fetch(`http://127.0.0.1:${LIVE_PORT}/health`, {
			redirect: "manual",
			signal: AbortSignal.timeout(2000),
		});
		const body = (await response.json()) as Record<string, unknown>;
		return { ok: response.ok, status: response.status, body };
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : "unknown",
		};
	}
}

function markerHits(marker: string): number {
	const proc = Bun.spawnSync(
		["rg", "-l", "--fixed-strings", marker, LIVE_WORKSPACE],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (proc.exitCode === 1) return 0;
	const text = proc.stdout.toString("utf8").trim();
	if (!text) return 0;
	return text.split("\n").filter((line) => line.length > 0).length;
}

function pinnedHead(): string {
	const proc = Bun.spawnSync(
		["git", "-C", PINNED_SOURCE, "rev-parse", "HEAD"],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return proc.stdout.toString("utf8").trim();
}

async function waitReadyFile(
	path: string,
	child: ReturnType<typeof Bun.spawn>,
	timeoutMs: number,
): Promise<ReadyInfo> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as ReadyInfo;
			if (
				typeof parsed.baseUrl === "string" &&
				typeof parsed.apiKey === "string"
			)
				return parsed;
		}
		if (child.exitCode !== null) {
			const stdoutLog = join(dirname(path), "runtime.stdout.log");
			const stderrLog = join(dirname(path), "runtime.stderr.log");
			const stdout = existsSync(stdoutLog)
				? readFileSync(stdoutLog, "utf8")
				: "";
			const stderr = existsSync(stderrLog)
				? readFileSync(stderrLog, "utf8")
				: "";
			throw new Error(
				"isolated runtime exited " +
					String(child.exitCode) +
					" before ready\nstdout:\n" +
					stdout +
					"\nstderr:\n" +
					stderr,
			);
		}
		await Bun.sleep(200);
	}
	throw new Error("isolated runtime ready.json timed out");
}

async function stopChild(
	child: ReturnType<typeof Bun.spawn>,
): Promise<{ exitCode: number | null; killed: boolean }> {
	if (child.exitCode !== null)
		return { exitCode: child.exitCode, killed: false };
	child.kill("SIGTERM");
	const term = await Promise.race([
		child.exited.then((code) => ({ code })),
		Bun.sleep(15000).then(() => null),
	]);
	if (term) return { exitCode: term.code, killed: true };
	child.kill("SIGKILL");
	const killed = await Promise.race([
		child.exited.then((code) => ({ code })),
		Bun.sleep(5000).then(() => null),
	]);
	return { exitCode: killed ? killed.code : child.exitCode, killed: true };
}

function expectUriError(
	label: string,
	error: unknown,
): Record<string, unknown> {
	if (!(error instanceof OpenVikingRequestError)) {
		return {
			label,
			ok: false,
			message: error instanceof Error ? error.message : "unknown",
		};
	}
	return {
		label,
		ok: error.kind === "uri",
		kind: error.kind,
		message: error.message,
	};
}

async function freePortCheck(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => {
				if (!address || typeof address === "string") {
					reject(new Error("no ephemeral port"));
					return;
				}
				resolve(address.port);
			});
		});
	});
}

const runtime = mkdtempSync(join(tmpdir(), "lina-ov-isolated-"));
const marker = `LINA_OV_ISOLATED_${digest(runtime).slice(0, 16)}`;
const createText = `# Isolated QA\n\ncreate ${marker}\n`;
const appendText = `append ${marker}\n`;
let child: ReturnType<typeof Bun.spawn> | undefined;
let ready: ReadyInfo | undefined;
let exitCode = 0;

try {
	const beforeLive = await liveHealth();
	const beforePort = await listening(LIVE_PORT);
	const probePort = await freePortCheck();
	record("preflight", {
		runtime,
		marker,
		liveListening: beforePort,
		liveHealth: beforeLive,
		ephemeralProbePort: probePort,
		refusedLivePort: probePort !== LIVE_PORT,
		venvPython: VENV_PYTHON,
		pinnedSource: PINNED_SOURCE,
		pinnedHead: pinnedHead(),
		liveConfUntouched: LIVE_CONF,
	});

	const childEnv = { ...process.env };
	for (const key of Object.keys(childEnv)) {
		if (key === "PATH" || key === "HOME" || key === "USER" || key === "LOGNAME")
			continue;
		if (
			key.startsWith("OPENVIKING_") ||
			key.startsWith("OPENAI_") ||
			key.startsWith("ARK_")
		)
			delete childEnv[key];
	}
	childEnv["PYTHONUNBUFFERED"] = "1";

	child = Bun.spawn([VENV_PYTHON, RUNTIME_SCRIPT, "--runtime-dir", runtime], {
		cwd: runtime,
		env: childEnv,
		stdout: openSync(join(runtime, "runtime.stdout.log"), "w"),
		stderr: openSync(join(runtime, "runtime.stderr.log"), "w"),
	});
	ready = await waitReadyFile(join(runtime, "ready.json"), child, 90000);
	if (ready.port === LIVE_PORT || ready.baseUrl.includes(`:${LIVE_PORT}`))
		throw new Error("isolated runtime bound live port 1933");
	if (
		ready.workspace === LIVE_WORKSPACE ||
		ready.workspace.startsWith(`${LIVE_WORKSPACE}/`)
	)
		throw new Error("isolated runtime used live workspace");
	if (ready.configPath === LIVE_CONF)
		throw new Error("isolated runtime used live ov.conf");

	record("runtime", {
		baseUrl: ready.baseUrl,
		rootUri: ready.rootUri,
		workspace: ready.workspace,
		configPath: ready.configPath,
		pid: ready.pid,
		port: ready.port,
		version: ready.version,
		packagePath: ready.packagePath,
		authMode: ready.authMode,
		modelStub: ready.modelStub,
		apiKeySha256: digest(ready.apiKey),
		isolatedListening: await listening(ready.port),
	});

	const client = new OpenVikingClient(
		{
			baseUrl: ready.baseUrl,
			apiKey: ready.apiKey,
			rootUri: ROOT_URI,
		},
		{ timeoutMs: 8000 },
	);
	record("client-status", { status: client.status });

	try {
		const listedEmpty = await client.list();
		record("list-before-write", {
			uri: listedEmpty.uri,
			entries: listedEmpty.entries.map((entry) => ({
				uri: entry.uri,
				name: entry.name,
				isDir: entry.isDir,
			})),
		});
	} catch (error) {
		record("list-before-write", {
			missingOk: true,
			kind: error instanceof OpenVikingRequestError ? error.kind : "unknown",
			status:
				error instanceof OpenVikingRequestError ? error.status : undefined,
			message: error instanceof Error ? error.message : "unknown",
		});
	}

	const created = await client.write(NOTE_URI, createText, "create");
	record("write-create", {
		uri: created.uri,
		mode: created.mode,
		writtenBytes: created.writtenBytes,
		semanticStatus: created.semanticStatus,
		vectorStatus: created.vectorStatus,
		retrievalReady: created.retrievalReady,
	});
	if (created.retrievalReady)
		throw new Error("create claimed retrievalReady; isolated QA must not");

	const listed = await client.list();
	record("list-after-create", {
		uri: listed.uri,
		entries: listed.entries.map((entry) => ({
			uri: entry.uri,
			name: entry.name,
			isDir: entry.isDir,
		})),
	});
	if (!listed.entries.some((entry) => entry.uri.endsWith("/notes.md")))
		throw new Error("list after create did not include notes.md");

	const readCreated = await client.read(NOTE_URI);
	record("read-after-create", {
		uri: readCreated.uri,
		content: readCreated.content,
		matches: readCreated.content === createText,
	});
	if (readCreated.content !== createText)
		throw new Error("read after create did not return exact text");

	const appended = await client.write(NOTE_URI, appendText, "append");
	record("write-append", {
		uri: appended.uri,
		mode: appended.mode,
		writtenBytes: appended.writtenBytes,
		semanticStatus: appended.semanticStatus,
		vectorStatus: appended.vectorStatus,
		retrievalReady: appended.retrievalReady,
	});
	if (appended.retrievalReady)
		throw new Error("append claimed retrievalReady; isolated QA must not");

	const expected = `${createText}${appendText}`;
	const readAppended = await client.read(NOTE_URI);
	record("read-after-append", {
		uri: readAppended.uri,
		content: readAppended.content,
		matches: readAppended.content === expected,
	});
	if (readAppended.content !== expected)
		throw new Error("read after append did not return concatenated text");

	const nativeUrl = `${ready.baseUrl}/api/v1/content/read?${new URLSearchParams(
		{
			uri: `${ROOT_URI}/notes.md`,
			offset: "0",
			limit: "-1",
		},
	).toString()}`;
	const native = await fetch(nativeUrl, {
		headers: { "X-API-Key": ready.apiKey },
		redirect: "manual",
		signal: AbortSignal.timeout(8000),
	});
	const envelope = (await native.json()) as {
		status?: string;
		result?: unknown;
	};
	record("native-read-contract", {
		urlHasOutput: nativeUrl.includes("output="),
		status: native.status,
		envelopeStatus: envelope.status,
		sameAsClient: envelope.result === readAppended.content,
		resultType: typeof envelope.result,
	});
	if (nativeUrl.includes("output="))
		throw new Error("content/read request unexpectedly included output");
	if (envelope.result !== readAppended.content)
		throw new Error("native content/read did not match client read");

	const escapes = [];
	for (const [label, uri] of [
		["user-memory", "viking://user/example/memories/escape.md"],
		["sibling-resource", "viking://resources/other/escape.md"],
		[
			"prefix-not-segment",
			"viking://resources/lina-isolated-qa-extra/escape.md",
		],
		["dotdot", "../escape.md"],
		["encoded-dotdot", "%2e%2e/escape.md"],
		["file-url", "file:///etc/passwd"],
		["absolute-path", "/etc/passwd"],
	] as const) {
		try {
			await client.read(uri);
			escapes.push({ label, ok: false, message: "accepted" });
		} catch (error) {
			escapes.push(expectUriError(label, error));
		}
	}
	record("scoped-escape", { cases: escapes });
	if (escapes.some((item) => item.ok !== true))
		throw new Error("scoped escape rejection incomplete");
} catch (error) {
	exitCode = 1;
	record("error", {
		message: error instanceof Error ? error.message : "unknown",
	});
} finally {
	const stopped = child
		? await stopChild(child)
		: { exitCode: null, killed: false };
	const isolatedPort = ready?.port;
	const afterLive = await liveHealth();
	const liveStillUp = await listening(LIVE_PORT);
	const isolatedStillUp =
		isolatedPort === undefined ? false : await listening(isolatedPort);
	const stdoutLog = join(runtime, "runtime.stdout.log");
	const stderrLog = join(runtime, "runtime.stderr.log");
	const runtimeStdout = existsSync(stdoutLog)
		? readFileSync(stdoutLog, "utf8").slice(-4000)
		: "";
	const runtimeStderr = existsSync(stderrLog)
		? readFileSync(stderrLog, "utf8").slice(-8000)
		: "";
	const errorPath = join(runtime, "error.json");
	let runtimeError: unknown;
	if (existsSync(errorPath)) {
		try {
			runtimeError = JSON.parse(readFileSync(errorPath, "utf8"));
		} catch {
			runtimeError = readFileSync(errorPath, "utf8").slice(-2000);
		}
	}
	const liveMarkerHits = markerHits(marker);
	record("teardown", {
		childExitCode: stopped.exitCode,
		sentKill: stopped.killed,
		liveStillListening: liveStillUp,
		liveHealth: afterLive,
		isolatedPortClosed: isolatedPort !== undefined && !isolatedStillUp,
		liveWorkspaceMarkerHits: liveMarkerHits,
		runtimeDir: runtime,
		runtimeStdout,
		runtimeStderr,
		runtimeError,
	});
	if (liveMarkerHits !== 0) {
		exitCode = 1;
		record("isolation-failure", {
			message: "unique marker leaked into live OpenViking workspace",
		});
	}
	try {
		rmSync(runtime, { recursive: true, force: true });
		record("runtime-removed", { ok: !existsSync(runtime) });
	} catch (error) {
		exitCode = 1;
		record("runtime-removed", {
			ok: false,
			message: error instanceof Error ? error.message : "unknown",
		});
	}
	writeFileSync(EVIDENCE, `${JSON.stringify(records, null, 2)}\n`);
	console.log(JSON.stringify(records, null, 2));
	process.exitCode = exitCode;
}
