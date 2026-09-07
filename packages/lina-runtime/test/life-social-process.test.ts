import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	runSocialProcess,
	SocialProcessError,
} from "../src/life/social/process.ts";

const entrypoint = fileURLToPath(
	new URL("./social-fixtures/process-worker.ts", import.meta.url),
);
const signal = () => new AbortController().signal;
function exited(error: unknown) {
	expect(error).toBeInstanceOf(SocialProcessError);
	if (!(error instanceof SocialProcessError)) throw error;
	expect(error.pid).toBeGreaterThan(0);
	expect(existsSync(`/proc/${error.pid}`)).toBe(false);
	return error;
}

test("owned child receives minimal environment and enforced DATA/CPU limits", async () => {
	const result = await runSocialProcess({
		entrypoint,
		input: "inspect",
		signal: signal(),
	});
	const info = JSON.parse(result.output);
	expect(info.env).toEqual({ LANG: "C" });
	expect(info.cwdFiles).toEqual([]);
	expect(info.limits).toMatch(/Max data size\s+536870912\s+536870912/);
	expect(info.limits).toMatch(/Max cpu time\s+3\s+3/);
	expect(existsSync(`/proc/${result.pid}`)).toBe(false);
	expect(existsSync(info.cwd)).toBe(false);
});

test("pre-aborted request starts no process", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runSocialProcess({ entrypoint, input: "busy", signal: controller.signal }),
	).rejects.toThrow("aborted");
});

test("busy child is reaped before timeout returns", async () => {
	try {
		await runSocialProcess({
			entrypoint,
			input: "busy",
			signal: signal(),
			timeoutMs: 100,
		});
		throw Error("expected timeout");
	} catch (error) {
		expect(exited(error).reason).toBe("timeout");
	}
});

test("busy child is reaped before in-flight abort returns", async () => {
	const controller = new AbortController();
	const ready = () => controller.abort();
	process.once("SIGUSR2", ready);
	try {
		await runSocialProcess({
			entrypoint,
			input: `busy-ready:${process.pid}`,
			signal: controller.signal,
		});
		throw Error("expected abort");
	} catch (error) {
		expect(exited(error).reason).toBe("aborted");
	} finally {
		process.removeListener("SIGUSR2", ready);
	}
});

test("oversized stdout kills and reaps the child", async () => {
	try {
		await runSocialProcess({
			entrypoint,
			input: "output",
			signal: signal(),
			maxBytes: 1024,
		});
		throw Error("expected pipe limit");
	} catch (error) {
		expect(exited(error).reason).toBe("output_limit");
	}
});

test("OOM is an exited failed computation", async () => {
	try {
		await runSocialProcess({ entrypoint, input: "oom", signal: signal() });
		throw Error("expected memory limit");
	} catch (error) {
		expect(exited(error).reason).toBe("process_exit");
	}
});

test("result followed by nonzero exit is never accepted", async () => {
	try {
		await runSocialProcess({ entrypoint, input: "crash", signal: signal() });
		throw Error("expected crash");
	} catch (error) {
		expect(exited(error).reason).toBe("process_exit");
	}
});

test("actual CPU limit terminates a running loop before wall deadline", async () => {
	try {
		await runSocialProcess({ entrypoint, input: "busy", signal: signal() });
		throw Error("expected CPU limit");
	} catch (error) {
		expect(exited(error).reason).toBe("process_exit");
	}
}, 8000);
