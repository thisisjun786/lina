import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../../lina-core/src/index.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { createWorldAuthorSession } from "../src/life/author-session.ts";
import { testSessionEngine } from "./fake-session-engine.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-teardown-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	let nativeCloses = 0;
	let closeNative = async () => {};
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "ordinary"),
		systemPrompt: "unused",
		ownsInstallation: () => true,
		createApp: async () => {
			throw Error("Ordinary sessions forbidden");
		},
		createWorldAuthor: async (input) => {
			const workspace = join(input.stateRoot, "native", "workspace");
			mkdirSync(workspace, { recursive: true });
			const engine = testSessionEngine();
			const create = engine.create.bind(engine);
			engine.create = async (options) => {
				const native = await create(options);
				native.close = async () => {
					nativeCloses++;
					await closeNative();
				};
				return native;
			};
			return createWorldAuthorSession({
				...input,
				workspace,
				engine,
				capabilityPolicyDigest: "a".repeat(64),
			});
		},
	});
	cleanup.push(() => fleet.close());
	fleet.life.create({ worldId: "test-world", authoredText: "Original" });
	const grant = fleet.grantWorldAuthor("test-world", "lina");
	const author = await fleet.openWorldAuthor(grant.id);
	return {
		fleet,
		author,
		grant,
		nativeCloses: () => nativeCloses,
		setNativeClose(close: () => Promise<void>) {
			closeNative = close;
		},
		held() {
			expect(() =>
				acquireSessionLease(
					join(root, "life", "author-sessions", grant.id),
					grant.agentId,
					author.binding.workspace,
				),
			).toThrow();
			expect(() =>
				acquireTranscriptLease(
					author.binding.sessionFile,
					grant.agentId,
					author.binding.workspace,
				),
			).toThrow();
		},
		released() {
			const lease = acquireSessionLease(
				join(root, "life", "author-sessions", grant.id),
				grant.agentId,
				author.binding.workspace,
			);
			const transcript = acquireTranscriptLease(
				author.binding.sessionFile,
				grant.agentId,
				author.binding.workspace,
			);
			transcript.close();
			lease.close();
		},
	};
}

test("runtime close error still awaits native exit, closes stores and removes finished fleet entry", async () => {
	const f = await fixture();
	const failure = Error("Unexpected runtime close failure");
	const close = f.author.runtime.close.bind(f.author.runtime);
	const entered = Promise.withResolvers<void>();
	const exit = Promise.withResolvers<void>();
	f.author.runtime.close = async () => {
		throw failure;
	};
	f.setNativeClose(async () => {
		entered.resolve();
		await exit.promise;
	});
	const stopped = f.fleet.close().then(
		() => undefined,
		(error) => error,
	);
	try {
		// Race against stop settlement so RED fails immediately if native close was skipped.
		expect(
			await Promise.race([
				entered.promise.then(() => "native"),
				stopped.then(() => "stopped"),
			]),
		).toBe("native");
		f.held();
		expect(f.author.runtime.store.history().messages).toEqual([]);
		exit.resolve();
		const error = await stopped;
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.errors).toContain(failure);
		expect(f.author.stopped).toBe(true);
		expect(() => f.author.runtime.store.history()).toThrow();
		expect(() => f.author.execution.snapshot()).toThrow();
		f.released();
		const stop = f.author.stop;
		f.author.stop = async () => {
			throw Error("Finished author retained in fleet");
		};
		try {
			await f.fleet.close();
		} finally {
			f.author.stop = stop;
		}
	} finally {
		exit.resolve();
		await stopped;
		f.author.runtime.close = close;
	}
});

test("database close failure retains leases after native exit and permits disposal retry", async () => {
	const f = await fixture();
	const store = f.author.runtime.store;
	const close = store.close.bind(store);
	const failure = Error("Author database close failed");
	store.close = () => {
		throw failure;
	};
	try {
		await expect(f.author.stop()).rejects.toBe(failure);
		expect(f.nativeCloses()).toBe(1);
		expect(f.author.stopped).toBe(false);
		f.held();
		store.close = close;
		await f.author.stop();
		expect(f.author.stopped).toBe(true);
		f.released();
	} finally {
		store.close = close;
	}
});

test("fleet revocation reports suggestion cancellation failure after runtime and native cleanup", async () => {
	const f = await fixture();
	const failure = Error("Unexpected suggestion shutdown failure");
	const cancel = f.fleet.life.cancelGrant.bind(f.fleet.life);
	f.fleet.life.cancelGrant = async () => {
		throw failure;
	};
	try {
		await expect(
			f.fleet.revokeWorldAuthor(f.grant.id, f.grant.revision),
		).rejects.toBe(failure);
		expect(f.nativeCloses()).toBe(1);
		expect(f.author.stopped).toBe(true);
		f.released();
	} finally {
		f.fleet.life.cancelGrant = cancel;
	}
});

test("failed native exit retains both leases and stores and cannot become a successful close no-op", async () => {
	const f = await fixture();
	const failure = Error("Native exit was not verified");
	f.setNativeClose(async () => {
		throw failure;
	});
	try {
		await expect(f.author.stop()).rejects.toBe(failure);
		f.held();
		expect(f.author.stopped).toBe(false);
		expect(f.author.runtime.store.history().messages).toEqual([]);
		expect(f.fleet.openedWorldAuthor(f.grant.id)).toBe(f.author);
		await expect(f.author.stop()).rejects.toBe(failure);
		expect(f.nativeCloses()).toBe(1);
		f.held();
	} finally {
		// Fault-injection cleanup only: this fixture owns no native process.
		f.author.runtime.native.close = async () => {};
		await f.author.stop();
	}
});

test("independent cancellation and runtime errors are both reported after complete cleanup", async () => {
	const f = await fixture();
	const cancellation = Error("Suggestion cancellation failed");
	const runtime = Error("Runtime cancellation failed");
	const cancel = f.fleet.life.cancelGrant.bind(f.fleet.life);
	const close = f.author.runtime.close.bind(f.author.runtime);
	f.fleet.life.cancelGrant = async () => {
		throw cancellation;
	};
	f.author.runtime.close = async () => {
		throw runtime;
	};
	try {
		const error = await f.author.stop().then(
			() => undefined,
			(error) => error,
		);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error.errors).toEqual([cancellation, runtime]);
		expect(f.nativeCloses()).toBe(1);
		expect(f.author.stopped).toBe(true);
		f.released();
	} finally {
		f.fleet.life.cancelGrant = cancel;
		f.author.runtime.close = close;
	}
});
