import { TaskError } from "../../../lina-codex/src/task-types.ts";
import { createWorkManagementAuthority } from "../../../lina-codex/src/task-work-authority.ts";
import {
	parseConfirmWorkInput,
	parseCorrectWorkInput,
	parseShareWorkInput,
	workId,
	workObject,
} from "../../../lina-codex/src/task-work-validation.ts";
import type { TaskManager } from "../../../lina-codex/src/tasks.ts";

export type TaskWorkOperations = Pick<
	TaskManager,
	| "workReceipts"
	| "workSharing"
	| "confirmWork"
	| "correctWork"
	| "shareWork"
	| "workDeliveries"
	| "workDeliveryAttempts"
	| "workDeliveryCurrent"
	| "retryWorkDelivery"
>;
type Port = Partial<TaskWorkOperations> & { list(): unknown };
const methods = [
	"workReceipts",
	"workSharing",
	"confirmWork",
	"correctWork",
	"shareWork",
	"workDeliveries",
	"workDeliveryAttempts",
	"workDeliveryCurrent",
	"retryWorkDelivery",
] as const;
function available(port: Port): port is Port & TaskWorkOperations {
	return methods.every((name) => typeof port[name] === "function");
}
const reply = (value: unknown, status = 200) =>
	Response.json(value, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
/** Resolve from the task manager's local state, without invoking native read/reconcile. */
function owner(
	tasks: Port,
	taskId: string,
	validOwner: (id: string) => boolean,
): string {
	const list = tasks.list();
	if (!Array.isArray(list))
		throw new TaskError("closed", "Task management unavailable");
	const task: unknown = list.find(
		(item: unknown) =>
			item && typeof item === "object" && "id" in item && item.id === taskId,
	);
	if (!task || typeof task !== "object")
		throw new TaskError("unknown_task", "Unknown task");
	if (
		!("ownerAgentId" in task) ||
		typeof task.ownerAgentId !== "string" ||
		!validOwner(task.ownerAgentId)
	)
		throw new TaskError("unauthorized", "Current task owner unavailable");
	return task.ownerAgentId;
}

/** Called only by taskRoutes under the existing protected local fleet HTTP server. */
export async function taskWorkRoutes(
	request: Request,
	tasks: Port,
	validOwner: (id: string) => boolean,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!/^\/api\/tasks\/[^/]+\/work(?:\/|$)/.test(url.pathname)) return;
	if (
		request.headers.has("origin") ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		request.headers.get("host") !== url.host
	)
		return reply({ error: "Forbidden" }, 403);
	const match =
		/^\/api\/tasks\/([a-zA-Z0-9_-]{1,128})\/work(?:\/(confirm|correct|share|retry))?$/.exec(
			url.pathname,
		);
	if (!match) return reply({ error: "Unknown task work route" }, 404);
	if (url.search) throw new TaskError("invalid_input", "Invalid work query");
	const taskId = match[1];
	if (!taskId) throw new TaskError("invalid_input", "Missing task id");
	const action = match[2];
	if (request.method !== (action ? "POST" : "GET"))
		return reply({ error: "Method not allowed" }, 405);
	if (!available(tasks))
		return reply({ error: "Task work management unavailable" }, 503);
	if (!action) {
		owner(tasks, taskId, validOwner);
		const receipts = tasks.workReceipts(taskId);
		return reply({
			receipts,
			sharing: [...new Set(receipts.map((receipt) => receipt.id))].map((id) =>
				tasks.workSharing(taskId, id),
			),
			deliveries: tasks
				.workDeliveries()
				.filter((d) => d.receipt.taskId === taskId)
				.map((delivery) => ({
					...delivery,
					attempts: tasks.workDeliveryAttempts(delivery.deliveryId),
				})),
		});
	}
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
		"application/json"
	)
		throw new TaskError("invalid_input", "JSON body required");
	const input = await json();
	// Resolve after body parsing. The task source rechecks this owner inside its serialized mutation.
	const authority = createWorkManagementAuthority(
		"local-task-management",
		owner(tasks, taskId, validOwner),
	);
	if (action === "confirm")
		return reply({
			receipt: await tasks.confirmWork(
				taskId,
				parseConfirmWorkInput(input),
				authority,
			),
		});
	if (action === "correct")
		return reply({
			receipt: await tasks.correctWork(
				taskId,
				parseCorrectWorkInput(input),
				authority,
			),
		});
	if (action === "share")
		return reply({
			sharing: await tasks.shareWork(
				taskId,
				parseShareWorkInput(input),
				authority,
			),
		});
	const retry = workObject(input, ["deliveryId", "payloadDigest"]);
	const deliveryId = workId(retry["deliveryId"]),
		digest = retry["payloadDigest"];
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
		throw new TaskError("invalid_input", "Invalid work digest");
	const delivery = tasks
		.workDeliveries()
		.find((d) => d.deliveryId === deliveryId);
	if (!delivery || delivery.receipt.taskId !== taskId)
		throw new TaskError(
			"unauthorized",
			"Work delivery does not belong to task",
		);
	if (!tasks.workDeliveryCurrent(deliveryId, digest))
		throw new TaskError("conflict", "Work delivery is stale");
	tasks.retryWorkDelivery(deliveryId, digest);
	return reply({
		delivery: tasks.workDeliveries().find((d) => d.deliveryId === deliveryId),
		attempts: tasks.workDeliveryAttempts(deliveryId),
	});
}
