import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInterventionServer } from "../../../lina-runtime/src/intervention/ws-server.ts";
import { assertHandshake, assertRestTrace } from "./e2e-assertions.ts";
import {
	ALLOWED_ID,
	eventStream,
	inject,
	type Mode,
	ready,
	type SinkCall,
	spawnDaemon,
	stopDaemon,
	withinDeadline,
} from "./e2e-harness.ts";
import { runReconnect } from "./e2e-reconnect.ts";
import { runStandard } from "./e2e-standard.ts";
import { type FakeDiscordEvent, startFakeDiscord } from "./fake-discord.ts";

async function runMode(mode: Mode): Promise<void> {
	const temp = await mkdtemp(join(tmpdir(), `lina-e2e-${mode}-`));
	const fake = startFakeDiscord();
	const fakeEvents = eventStream<FakeDiscordEvent>();
	const unsubscribe = fake.onEvent(fakeEvents.push);
	const calls = eventStream<SinkCall>();
	const sink = {
		sendUserMessage(
			text: string,
			options?: { readonly deliverAs?: "steer" | "followUp" },
		): void {
			calls.push({ text, deliverAs: options?.deliverAs });
		},
	};
	const intervention = await startInterventionServer({
		port: 0,
		currentStatus: () => "idle",
		sink,
	});
	let daemon = spawnDaemon({
		fake,
		interventionPort: intervention.port,
		cursorPath: join(temp, "cursor.json"),
		mode,
	});
	try {
		await ready(daemon, mode);
		if (mode === "reconnect") {
			const firstId = await inject(fake, ALLOWED_ID, "hello lina");
			await runReconnect({
				firstId,
				fake,
				fakeEvents,
				calls,
				intervention,
				daemon,
				sink,
			});
		} else {
			daemon = await runStandard({
				mode,
				temp,
				fake,
				fakeEvents,
				calls,
				intervention,
				daemon,
			});
		}
		if (mode !== "gateway-off" && fake.handshake().heartbeatCount === 0) {
			const heartbeat = fakeEvents.count();
			await fakeEvents.wait(
				(event) => event.kind === "gateway" && event.state === "heartbeat",
				heartbeat,
				"Gateway heartbeat missing",
			);
		}
		assertHandshake(fake, mode);
		assertRestTrace(fake, mode);
	} finally {
		await stopDaemon(daemon, "SIGINT");
		await stopDaemon(daemon, "SIGINT");
		unsubscribe();
		await withinDeadline(intervention.stop(), "intervention cleanup timed out");
		await withinDeadline(fake.stop(), "fake Discord cleanup timed out");
		await rm(temp, { recursive: true, force: true });
		console.log(
			`CLEANUP mode=${mode} fake_port=${fake.port} intervention_port=${intervention.port} temp_removed=true`,
		);
	}
}

async function main(): Promise<void> {
	try {
		const { E2E_RECONNECT: reconnect } = process.env;
		if (reconnect === "1") await runMode("reconnect");
		else {
			await runMode("gateway");
			await runMode("gateway-off");
		}
		console.log(
			reconnect === "1"
				? "E2E_PASS reconnect"
				: "E2E_PASS gateway\nE2E_PASS gateway-off",
		);
	} catch (error) {
		console.error(
			`E2E_FAIL ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
