import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import type {
	WorkDelivery,
	WorkDeliveryAttempt,
	WorkReceipt,
	WorkSharingDecision,
} from "../../lina-codex/src/task-work-types.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import { taskRoutes } from "../src/fleet/task-routes.ts";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { required, workBridgeFixture } from "./helpers/work-bridge.ts";

test("real protected task HTTP confirm/share/correct/retry and durable history use explicit management", async () => {
	const f = await workBridgeFixture();
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: join(dirname(f.taskPath), "fleet"),
		agentDir: join(dirname(f.taskPath), "auth"),
		systemPrompt: "unused",
		ownsInstallation: () => true,
		createApp: async () => {
			throw Error("No session/provider may start");
		},
	});
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
		route: (request, json) =>
			taskRoutes(request, f.tasks, (id) => !!fleet.agents.get(id), json),
	});
	const base = `http://127.0.0.1:${server.port}/api/tasks/${f.task.id}/work`;
	const send = (
		action = "",
		body?: unknown,
		headers?: Record<string, string>,
	) =>
		fetch(`${base}${action}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { "content-type": "application/json", ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const errors: unknown[] = [];
	const bridge = createWorkBridge({
		source: f.tasks,
		world: f.world.store,
		onError: (error) => errors.push(error),
	});
	try {
		bridge.start();
		const confirm = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 1,
			requestId: "http-confirm",
			evidenceRef: "owner-inspected-evidence",
		};
		expect((await send("/confirm", confirm)).status).toBe(200);
		expect((await send("/confirm", confirm)).status).toBe(200);
		expect(
			(await send("/confirm", { ...confirm, evidenceRef: "changed evidence" }))
				.status,
		).toBe(409);
		const share = {
			receiptId: f.receipt.id,
			expectedPolicyRevision: 0,
			requestId: "http-share",
			selection: f.selection,
		};
		expect((await send("/share", share)).status).toBe(200);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source.fields?.outcome,
		).toBe("verified_result");
		f.configure(null);
		const correction = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 2,
			requestId: "http-amend",
			kind: "amend",
			reason: "Evidence withdrawn",
		};
		expect((await send("/correct", correction)).status).toBe(200);
		const withheld = required(f.tasks.pendingWorkDeliveries()[0]);
		expect(withheld.status).toBe("withheld");
		f.configure(f.work);
		expect(
			(
				await send("/retry", {
					deliveryId: withheld.deliveryId,
					payloadDigest: "0".repeat(64),
				})
			).status,
		).toBe(409);
		expect(
			(
				await send("/retry", {
					deliveryId: withheld.deliveryId,
					payloadDigest: withheld.payloadDigest,
				})
			).status,
		).toBe(200);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source.receipt,
		).toMatchObject({
			receiptRevision: 3,
			outcome: "turn_ended",
			correction: { kind: "amend" },
		});
		expect(
			(
				await send("/correct", {
					...correction,
					expectedReceiptRevision: 3,
					requestId: "http-retract",
					kind: "retract",
				})
			).status,
		).toBe(200);
		expect(
			f.world.store.workEvidence(f.worldId).records[0]?.source.operation,
		).toBe("restrict");
		const read = await send();
		expect(read.status).toBe(200);
		expect(read.headers.get("cache-control")).toBe("no-store");
		// HTTP JSON boundary; assertions below verify the management response contract.
		const data = (await read.json()) as {
			receipts: WorkReceipt[];
			sharing: WorkSharingDecision[];
			deliveries: Array<WorkDelivery & { attempts: WorkDeliveryAttempt[] }>;
		};
		expect(data.receipts).toHaveLength(4);
		expect(data.sharing).toHaveLength(1);
		expect(data.deliveries).toHaveLength(3);
		expect(required(data.deliveries[1]).attempts.map((a) => a.status)).toEqual([
			"withheld",
			"pending",
			"delivered",
		]);
		expect(errors).toEqual([]);
		expect(f.rpc.calls("turn/start")).toHaveLength(1);
	} finally {
		bridge.close();
		await server.stop();
		await f.close();
	}
});

test("real task server rejects Origin, hostile Host, methods, malformed and oversized bodies before mutation", async () => {
	const f = await workBridgeFixture();
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: join(dirname(f.taskPath), "fleet"),
		agentDir: join(dirname(f.taskPath), "auth"),
		systemPrompt: "unused",
		ownsInstallation: () => true,
		createApp: async () => {
			throw Error("No session/provider may start");
		},
	});
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
		route: (request, json) => taskRoutes(request, f.tasks, () => true, json),
	});
	const base = `http://127.0.0.1:${server.port}/api/tasks/${f.task.id}/work`;
	try {
		const input = {
			receiptId: f.receipt.id,
			expectedReceiptRevision: 1,
			requestId: "guard-confirm",
			evidenceRef: "evidence",
		};
		const post = (body: string, headers: Record<string, string> = {}) =>
			fetch(`${base}/confirm`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body,
			});
		expect(
			(await post(JSON.stringify(input), { origin: "https://attacker.test" }))
				.status,
		).toBe(403);
		expect(
			(await post(JSON.stringify(input), { host: "attacker.test" })).status,
		).toBe(403);
		expect((await fetch(`${base}/confirm`)).status).toBe(405);
		expect((await fetch(base, { method: "DELETE" })).status).toBe(405);
		expect((await fetch(`${base}?ownerAgentId=mira`)).status).toBe(400);
		expect((await fetch(`${base}/observe`)).status).toBe(404);
		expect((await post("[]")).status).toBe(400);
		expect((await post("{")).status).toBe(400);
		expect(
			(await post(JSON.stringify(input), { "content-type": "text/plain" }))
				.status,
		).toBe(400);
		for (const extra of [
			{ authority: "owner" },
			{ ownerAgentId: "lina" },
			{ outcome: "verified_result" },
			{ verifierId: "trusted" },
			{ participantAgentIds: ["mira"] },
		])
			expect((await post(JSON.stringify({ ...input, ...extra }))).status).toBe(
				400,
			);
		expect(
			(await post(JSON.stringify({ ...input, evidenceRef: "x".repeat(70000) })))
				.status,
		).toBe(400);
		expect(f.tasks.workReceipts(f.task.id)).toHaveLength(1);
		expect(f.tasks.workDeliveries()).toEqual([]);
	} finally {
		await server.stop();
		await f.close();
	}
});
