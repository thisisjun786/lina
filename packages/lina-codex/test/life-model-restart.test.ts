import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
	lifeFixture,
	lifeRequest,
	lifeResponse,
} from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});

nativeTest(
	"usage fsync followed by SIGKILL recovers accounting without inventing a result or retry",
	async () => {
		const f = lifeFixture();
		clean.push(() => f.close());
		const base = { root: f.root, origin: f.selection.connection.origin };
		const prepared = (
			await processFixture({
				...base,
				mode: "prepare",
				request: lifeRequest(),
			}).result()
		).value;
		const killed = processFixture({
			...base,
			mode: "crash_after_usage",
			prepared,
		});
		await killed.child.exited;
		const reopened = await processFixture({
			...base,
			mode: "reconcile",
			prepared,
		}).result();
		expect(reopened.value).toEqual({
			status: "unknown",
			usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
			upstreamAttempts: 1,
		});
		expect(
			(await processFixture({ ...base, mode: "complete", prepared }).result())
				.ok,
		).toBe(false);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);
function processFixture(value: unknown) {
	const child = Bun.spawn(
		[process.execPath, join(import.meta.dir, "life-model-process-fixture.ts")],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	child.stdin.write(JSON.stringify(value));
	child.stdin.end();
	clean.push(async () => {
		if (child.exitCode === null) child.kill();
		await child.exited;
	});
	return {
		child,
		async result() {
			const [exit, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exit).toBe(0);
			return JSON.parse(stdout);
		},
	};
}

nativeTest(
	"prepared/result journals survive actual parent restarts and competing processes dispatch once",
	async () => {
		const f = lifeFixture();
		clean.push(() => f.close());
		const base = { root: f.root, origin: f.selection.connection.origin };
		const first = await processFixture({
			...base,
			mode: "prepare",
			request: lifeRequest(),
		}).result();
		expect(first.ok).toBe(true);
		expect(f.captures).toHaveLength(0);
		const saved = await processFixture({
			...base,
			mode: "reconcile",
			prepared: first.value,
		}).result();
		expect(saved.value).toEqual({ status: "not_dispatched" });
		const second = processFixture({
			...base,
			mode: "complete",
			prepared: first.value,
		});
		const competitor = processFixture({
			...base,
			mode: "complete",
			prepared: first.value,
		});
		const results = await Promise.all([second.result(), competitor.result()]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(f.captures).toHaveLength(1);
		const result = results.find((r) => r.ok).value;
		const reopened = await processFixture({
			...base,
			mode: "reconcile",
			prepared: first.value,
		}).result();
		expect(reopened.value).toEqual({ status: "completed", result });
		expect(f.captures).toHaveLength(1);
	},
	60000,
);

nativeTest(
	"killed dispatch parent leaves an unknown marker and restart performs no inference",
	async () => {
		const release = Promise.withResolvers<Response>();
		const f = lifeFixture(() => release.promise);
		clean.push(() => f.close());
		const base = { root: f.root, origin: f.selection.connection.origin };
		const prepared = (
			await processFixture({
				...base,
				mode: "prepare",
				request: lifeRequest(),
			}).result()
		).value;
		const running = processFixture({ ...base, mode: "complete", prepared });
		await f.entered;
		running.child.kill("SIGKILL");
		await running.child.exited;
		release.resolve(lifeResponse());
		const reopened = await processFixture({
			...base,
			mode: "reconcile",
			prepared,
		}).result();
		expect(reopened.value).toEqual({
			status: "unknown",
			usage: { inputTokens: null, outputTokens: null, totalTokens: null },
			upstreamAttempts: 1,
		});
		const retry = await processFixture({
			...base,
			mode: "complete",
			prepared,
		}).result();
		expect(retry.ok).toBe(false);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);
