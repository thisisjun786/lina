/**
 * Behavior tests for scripts/qa/discord-live.ts. Every run spawns the real
 * script as a child process against loopback fakes only; the token here is a
 * fixture string that never leaves the machine.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

const SCRIPT = "packages/lina-channels/scripts/qa/discord-live.ts";
const TOKEN = "test-token-fixture";
const CHANNEL = "1";
const NOW = "2026-09-04T00:00:00+00:00";
const BASE_ENV_KEYS = ["PATH", "HOME"] as const;

type RunResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

function bounded<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	const signal = AbortSignal.timeout(ms);
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			signal.addEventListener(
				"abort",
				() => reject(new Error(`${label} did not settle within ${ms}ms`)),
				{ once: true },
			);
		}),
	]);
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of BASE_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			env[key] = value;
		}
	}
	return { ...env, ...extra };
}

function spawnLive(extra: Record<string, string>) {
	return Bun.spawn(["bun", SCRIPT], {
		env: cleanEnv(extra),
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function runLive(
	extra: Record<string, string>,
	budgetMs = 30_000,
): Promise<RunResult> {
	const proc = spawnLive(extra);
	const code = await bounded(proc.exited, budgetMs, "live script");
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code, stdout, stderr };
}

function fakeMessage(id: string, content: string) {
	return {
		id,
		channel_id: CHANNEL,
		author: { id: "777", bot: false },
		content,
		timestamp: NOW,
	};
}

const PostedSchema = z.object({ content: z.string() });
type Posted = z.infer<typeof PostedSchema>;

type Fake = {
	readonly url: string;
	readonly posted: Posted[];
	readonly seen: Promise<void>;
};

const servers: Bun.Server<undefined>[] = [];

function startFake(
	handler: (
		req: Request,
		fake: { posted: Posted[] },
	) => Response | Promise<Response>,
): Fake {
	const posted: Posted[] = [];
	let markSeen: () => void = () => {};
	const seen = new Promise<void>((resolve) => {
		markSeen = resolve;
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			markSeen();
			return handler(req, { posted });
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}/api/v10`, posted, seen };
}

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

function liveEnv(fakeUrl: string): Record<string, string> {
	return {
		DISCORD_BOT_TOKEN: TOKEN,
		DISCORD_CHANNEL_ID: CHANNEL,
		LINA_DISCORD_REST_API: fakeUrl,
	};
}

/** Fake REST: getMe ok, one latest message, ping echo on POST + after-list. */
function startEchoFake(
	latestContent: string,
	afterQueries: (string | null)[],
): Fake {
	return startFake(async (req, state) => {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/users/@me")) {
			return Response.json({ id: "bot1" });
		}
		if (req.method === "GET") {
			const after = url.searchParams.get("after");
			if (after === null) {
				return Response.json([fakeMessage("55", latestContent)]);
			}
			afterQueries.push(after);
			return Response.json([fakeMessage("91", state.posted[0]?.content ?? "")]);
		}
		state.posted.push(PostedSchema.parse(await req.json()));
		return Response.json({ id: "91" });
	});
}

const startHungFake = (): Fake =>
	startFake(() => new Promise<Response>(() => {}));

describe("discord-live QA script", () => {
	it("prints the exact skip line and exits 0 when DISCORD_BOT_TOKEN is unset", async () => {
		// Given no Discord env at all
		const result = await runLive({});
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("skipped: DISCORD_BOT_TOKEN unset");
	});

	it("prints the same skip line when only the channel id is unset", async () => {
		// Given a token but no channel id
		const result = await runLive({ DISCORD_BOT_TOKEN: TOKEN });
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("skipped: DISCORD_BOT_TOKEN unset");
	});

	it("prints LIVE_FAIL: DiscordAuthError without the token when the fake answers 401", async () => {
		// Given a fake that answers getMe with 401 echoing the token
		const fake = startFake(() =>
			Response.json({ message: `bad token ${TOKEN}` }, { status: 401 }),
		);
		const result = await runLive(liveEnv(fake.url));
		// Then it fails with the exact sentinel and never leaks the token
		expect(result.code).toBe(1);
		expect(result.stderr.trim()).toMatch(/^LIVE_FAIL: DiscordAuthError/);
		expect(result.stdout + result.stderr).not.toContain(TOKEN);
	});

	it("warns to enable the Message Content Intent when the latest message has empty content", async () => {
		// Given a fake whose latest message carries empty content
		const fake = startEchoFake("", []);
		const result = await runLive(liveEnv(fake.url));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			"WARN: content empty - enable Message Content Intent",
		);
	});

	it("posts the QA ping and reads it back after the previous latest id when the fake answers success", async () => {
		// Given a fake with one earlier message that echoes the posted ping
		const afterQueries: (string | null)[] = [];
		const fake = startEchoFake("earlier message", afterQueries);
		const result = await runLive(liveEnv(fake.url));
		// Then the ping is posted, read back after the previous latest id, and LIVE_OK prints
		expect(result.code).toBe(0);
		expect(fake.posted).toHaveLength(1);
		expect(fake.posted[0]?.content).toMatch(
			/^LINA_DISCORD_QA_PING_[0-9a-f-]{36}$/,
		);
		expect(afterQueries).toEqual(["55"]);
		expect(result.stdout).toContain("LIVE_OK");
		expect(result.stdout).toContain(
			"LINA_IDLE_NUDGE_MS=0 ./scripts/run-lina.sh --no-loop",
		);
		expect(result.stdout).toContain("./scripts/run-channels.sh");
	});

	it("refuses without any request when the REST base override is off-host", async () => {
		// Given a non-loopback REST base override and no fake at all
		const result = await runLive({
			DISCORD_BOT_TOKEN: TOKEN,
			DISCORD_CHANNEL_ID: CHANNEL,
			LINA_DISCORD_REST_API: "https://evil.example.com",
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("LIVE_FAIL:");
		expect(result.stderr).toContain("loopback");
		expect(servers).toHaveLength(0);
	});

	it("fails with a deadline error when the fake never responds", async () => {
		// Given a fake that hangs forever and a short QA deadline
		const fake = startHungFake();
		// When the script runs with an 800ms deadline
		const result = await runLive({
			...liveEnv(fake.url),
			LINA_QA_DEADLINE_MS: "800",
		});
		// Then it exits 1 via the deadline path, not the 10s request timeout
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("LIVE_FAIL:");
		expect(result.stderr).toContain("deadline exceeded");
	});

	it("exits 130 when SIGINT arrives mid-request", async () => {
		// Given a hung fake and a spawned script blocked inside getMe
		const fake = startHungFake();
		const proc = spawnLive(liveEnv(fake.url));
		await bounded(fake.seen, 10_000, "request arrival");
		// When SIGINT is delivered
		proc.kill("SIGINT");
		const code = await bounded(proc.exited, 10_000, "signal shutdown");
		// Then the script exits 130 with the interrupted line
		expect(code).toBe(130);
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toContain("interrupted");
	});
});
