import { afterEach, expect, test } from "bun:test";
import { entry } from "../../lina-core/test/fixture.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { startControlServer } from "../src/control-server.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
function setup() {
	const fixture = createRuntimeFixture();
	cleanups.push(fixture.close);
	const server = startControlServer({ runtime: fixture.runtime, port: 0 });
	cleanups.push(server.stop);
	return { ...fixture, url: `http://127.0.0.1:${server.port}` };
}
function connect(url: string, origin?: string) {
	const socket = new WebSocket(url.replace("http", "ws"), {
		headers: origin ? { Origin: origin } : {},
	});
	const queue: unknown[] = [],
		waiting: ((value: unknown) => void)[] = [];
	socket.addEventListener("message", (event) => {
		const value: unknown = JSON.parse(String(event.data));
		const waiter = waiting.shift();
		if (waiter) waiter(value);
		else queue.push(value);
	});
	cleanups.push(async () => {
		socket.close();
	});
	const next = () =>
		queue.length
			? Promise.resolve(queue.shift())
			: new Promise<unknown>((resolve) => waiting.push(resolve));
	return {
		socket,
		next,
		async type(type: string) {
			for (let i = 0; i < 200; i++) {
				const frame = await next();
				if (
					typeof frame === "object" &&
					frame !== null &&
					"type" in frame &&
					frame.type === type
				)
					return frame;
			}
			throw new Error("Expected frame did not arrive");
		},
	};
}

test("snapshot and existing history frames page human rows while original text stays native", async () => {
	const { url, store, runtime, native } = setup();
	for (let i = 0; i < 102; i++) {
		store.appendEntry(entry(`tool-${i}`, { role: "tool" }));
		store.appendEntry(entry(`human-${i}`, { role: "user" }));
	}
	for (let i = 0; i < 125; i++)
		store.appendEntry(
			entry(`commentary-${i}`, { raw: { message: { stopReason: "toolUse" } } }),
		);
	const code = "Result:\n```ts\nconst answer = 42;\n```";
	const raw = {
		type: "message",
		id: "native-final",
		timestamp: "2026-09-06T00:00:00.000Z",
		message: {
			role: "assistant",
			phase: null,
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "private" },
				{
					type: "text",
					text: code,
					textSignature: '{"phase":"final_answer"}',
				},
			],
		},
	};
	const commentary = {
		...raw,
		id: "native-commentary",
		message: {
			...raw.message,
			content: [
				{
					type: "text",
					text: "Reading source files",
					textSignature: '{"phase":"commentary"}',
				},
			],
		},
	};
	native.emit({ type: "entry_appended", entry: commentary });
	native.emit({ type: "entry_appended", entry: raw });
	const snapshot = runtime.snapshot();
	expect(snapshot.messages).toHaveLength(100);
	expect(snapshot.messages[0]?.entryId).toBe("human-3");
	expect(snapshot.beforeCursor).toBe(8);
	expect(snapshot.hasEarlier).toBe(true);
	expect(snapshot.messages.at(-1)?.text).toBe(code);
	expect(
		snapshot.messages.some((row) => row.entryId === "native-commentary"),
	).toBe(false);
	const peer = connect(url);
	await peer.next();
	peer.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	expect(await peer.next()).toEqual({ type: "snapshot", snapshot });
	peer.socket.send(
		JSON.stringify({ type: "history", sessionId: "test-session", before: 8 }),
	);
	expect(await peer.next()).toMatchObject({
		type: "history",
		sessionId: "test-session",
		revision: store.revision(),
		before: 8,
		page: {
			messages: [
				{ entryId: "human-0", seq: 2 },
				{ entryId: "human-1", seq: 4 },
				{ entryId: "human-2", seq: 6 },
			],
			beforeCursor: 2,
			hasEarlier: false,
		},
	});
	peer.socket.send(
		JSON.stringify({
			type: "entry",
			sessionId: "test-session",
			entryId: "native-final",
			offset: 0,
		}),
	);
	expect(await peer.next()).toEqual({
		type: "entry-text",
		sessionId: "test-session",
		entryId: "native-final",
		offset: 0,
		text: code,
		nextOffset: null,
	});
	expect(store.entry("native-final")?.raw).toEqual(raw);
	expect(store.entry("native-commentary")).toMatchObject({
		text: "Reading source files",
		raw: commentary,
	});
	expect(
		store
			.history()
			.messages.some((row) => row.entryId.startsWith("commentary-")),
	).toBe(true);
	expect(native.calls).toEqual([]);
});

test("ping rejects foreign sessions, then echoes the owned nonce without journal changes", async () => {
	const { url, store, runtime, native } = setup();
	store.appendEntry(entry("kept"));
	store.createRequest("queued", "do not start");
	const before = {
		revision: store.revision(),
		entries: store.scanAfter(0),
		requests: store.requests(),
	};
	const notices: unknown[] = [];
	const unsubscribe = runtime.subscribe((notice) => notices.push(notice));
	cleanups.push(async () => unsubscribe());
	const peer = connect(url);
	await peer.next();
	peer.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	await peer.next();
	peer.socket.send(
		JSON.stringify({
			type: "ping",
			sessionId: "foreign",
			nonce: "wrong-session",
		}),
	);
	expect(await peer.next()).toEqual({
		type: "error",
		message: "Session changed; reconnect before sending",
	});
	for (const nonce of ["first", "n".repeat(128)]) {
		peer.socket.send(
			JSON.stringify({ type: "ping", sessionId: "test-session", nonce }),
		);
		expect(await peer.next()).toEqual({
			type: "pong",
			sessionId: "test-session",
			nonce,
		});
	}
	expect({
		revision: store.revision(),
		entries: store.scanAfter(0),
		requests: store.requests(),
	}).toEqual(before);
	expect(notices).toEqual([]);
	expect(native.calls).toEqual([]);
});

test("the unchanged web gateway forwards ping and pong through shared wire parsers", async () => {
	const { url, store, native } = setup();
	const gateway = startWebServer({
		port: 0,
		upstream: url.replace("http", "ws"),
		assets: { html: "", script: "", css: "", icon: "" },
	});
	cleanups.push(async () => gateway.stop(true));
	const origin = `http://127.0.0.1:${gateway.port}`;
	const peer = connect(`${origin}/ws`, origin);
	expect(await peer.next()).toEqual({ type: "agent-status", state: "idle" });
	peer.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	await peer.next();
	const revision = store.revision();
	peer.socket.send(
		JSON.stringify({
			type: "ping",
			sessionId: "test-session",
			nonce: "gateway-probe",
		}),
	);
	expect(await peer.next()).toEqual({
		type: "pong",
		sessionId: "test-session",
		nonce: "gateway-probe",
	});
	expect(store.revision()).toBe(revision);
	expect(store.scanAfter(0)).toEqual([]);
	expect(native.calls).toEqual([]);
});

test("same session and history restore on a new socket; requests deduplicate", async () => {
	const { native, url, store } = setup();
	native.onPrompt = async (text, admission) => {
		native.user("user-entry", text);
		admission.disposition("started");
	};
	const first = connect(url);
	await first.next();
	first.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	expect(await first.type("snapshot")).toMatchObject({
		snapshot: { sessionId: "test-session", messages: [] },
	});
	first.socket.send(
		JSON.stringify({
			type: "chat",
			sessionId: "test-session",
			id: "browser-1",
			text: "Keep me",
		}),
	);
	await first.type("ack");
	expect(store.request("browser-1")?.entryId).toBe("user-entry");
	const second = connect(url);
	await second.next();
	second.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	expect(await second.type("snapshot")).toMatchObject({
		snapshot: {
			sessionId: "test-session",
			messages: [{ entryId: "user-entry", text: "Keep me" }],
		},
	});
	second.socket.send(
		JSON.stringify({
			type: "chat",
			sessionId: "test-session",
			id: "browser-1",
			text: "Keep me",
		}),
	);
	await second.type("ack");
	expect(native.calls).toEqual(["Keep me"]);
});

test("a browser cannot skip the gateway or mutate a foreign session", async () => {
	const { url, native } = setup();
	expect(
		(await fetch(`${url}/health`, { headers: { Origin: "http://evil.test" } }))
			.status,
	).toBe(403);
	const peer = connect(url);
	await peer.next();
	peer.socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
	await peer.type("snapshot");
	peer.socket.send(
		JSON.stringify({
			type: "chat",
			sessionId: "other",
			id: "r",
			text: "wrong owner",
		}),
	);
	expect(await peer.type("error")).toMatchObject({
		message: "Session changed; reconnect before sending",
	});
	expect(native.calls).toEqual([]);
});

test("explicit original-text pages are bounded and do not expose raw reasoning fields", async () => {
	const { url, store } = setup();
	store.appendEntry({
		entryId: "large",
		role: "assistant",
		text: "a".repeat(10000),
		timestamp: new Date().toISOString(),
		raw: { thinking: "private metadata" },
	});
	const peer = connect(url);
	await peer.next();
	peer.socket.send(
		JSON.stringify({
			type: "entry",
			sessionId: "test-session",
			entryId: "large",
			offset: 0,
		}),
	);
	const frame = await peer.type("entry-text");
	expect(frame).toMatchObject({ text: "a".repeat(8192), nextOffset: 8192 });
	expect(JSON.stringify(frame)).not.toContain("private metadata");
});

test("shared search endpoint returns human matches without submitting work and rejects another session", async () => {
	const { url, store, runtime, native } = setup();
	store.appendEntry(entry("search-user", { role: "user", text: "찾을 기억" }));
	store.appendEntry(entry("search-tool", { role: "tool", text: "찾을 기억" }));
	const revision = store.revision(),
		requests = store.requests();
	const peer = connect(url);
	await peer.type("agent-status");
	peer.socket.send(
		JSON.stringify({
			type: "search",
			sessionId: runtime.binding.sessionId,
			requestId: "lookup",
			query: "기억",
			before: Number.MAX_SAFE_INTEGER,
		}),
	);
	expect(await peer.type("search-results")).toMatchObject({
		requestId: "lookup",
		page: { messages: [{ entryId: "search-user" }] },
	});
	expect(store.revision()).toBe(revision);
	expect(store.requests()).toEqual(requests);
	peer.socket.send(
		JSON.stringify({
			type: "search",
			sessionId: "foreign",
			requestId: "wrong",
			query: "기억",
			before: Number.MAX_SAFE_INTEGER,
		}),
	);
	expect(await peer.type("error")).toMatchObject({
		message: "Session changed; reconnect before sending",
	});
	void native;
});

test("search detail correlation and errors cannot disturb the shared conversation socket", async () => {
	const { url, store, runtime } = setup();
	store.appendEntry(entry("detail", { text: "full answer" }));
	const revision = store.revision(),
		peer = connect(url);
	await peer.type("agent-status");
	peer.socket.send(
		JSON.stringify({
			type: "entry",
			sessionId: runtime.binding.sessionId,
			entryId: "detail",
			offset: 0,
			requestId: "read-1",
		}),
	);
	expect(await peer.type("entry-text")).toMatchObject({
		requestId: "read-1",
		text: "full answer",
	});
	peer.socket.send(
		JSON.stringify({
			type: "entry",
			sessionId: runtime.binding.sessionId,
			entryId: "missing",
			offset: 0,
			requestId: "read-2",
		}),
	);
	expect(await peer.type("search-error")).toMatchObject({
		requestId: "read-2",
	});
	peer.socket.send(
		JSON.stringify({
			type: "ping",
			sessionId: runtime.binding.sessionId,
			nonce: "still-connected",
		}),
	);
	expect(await peer.type("pong")).toMatchObject({ nonce: "still-connected" });
	expect(store.revision()).toBe(revision);
});
