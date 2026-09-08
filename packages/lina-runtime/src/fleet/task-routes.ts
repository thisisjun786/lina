import { type TaskWorkOperations, taskWorkRoutes } from "./task-work-routes.ts";

/** HTTP only depends on task operations; the Codex manager owns native execution. */
export interface TaskRoutePort extends Partial<TaskWorkOperations> {
	reply?(
		id: string,
		input: {
			approvalId: string;
			decision: "accept" | "decline" | "cancel" | "acceptForSession";
			expectedRevision: number;
		},
	): Promise<unknown>;
	list(): unknown;
	create(input: {
		ownerAgentId: string;
		title: string;
		cwd: string;
		prompt: string;
		requestId: string;
		model?: string;
	}): Promise<unknown>;
	read(id: string): Promise<unknown>;
	message(
		id: string,
		input: { text: string; requestId: string; expectedRevision: number },
	): Promise<unknown>;
	interrupt(id: string, expectedRevision: number): Promise<unknown>;
	handover(
		id: string,
		input: { ownerAgentId: string; expectedRevision: number },
	): Promise<unknown>;
}
const reply = (data: unknown, status = 200) =>
	Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
function text(value: unknown, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw Error("Invalid input");
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw Error("Invalid expectedRevision");
	return value;
}
function fields(
	input: Record<string, unknown>,
	allowed: string[],
	required: string[],
) {
	if (
		Object.keys(input).some((k) => !allowed.includes(k)) ||
		required.some((k) => !Object.hasOwn(input, k))
	)
		throw Error("Invalid fields");
}
export async function taskRoutes(
	request: Request,
	tasks: TaskRoutePort,
	validOwner: (id: string) => boolean,
	json: () => Promise<Record<string, unknown>>,
): Promise<Response | undefined> {
	try {
		const work = await taskWorkRoutes(request, tasks, validOwner, json);
		if (work) return work;
		const url = new URL(request.url),
			match =
				/^\/api\/tasks(?:\/([a-zA-Z0-9_-]{1,128})(?:\/(messages|interrupt|owner|approval))?)?$/.exec(
					url.pathname,
				);
		if (!match) return;
		if (url.search) return reply({ error: "요청 주소를 확인해주세요." }, 400);
		const [, id, action] = match;
		if (request.method === "GET" && !action)
			return reply(id ? await tasks.read(id) : { tasks: await tasks.list() });
		if (request.method !== "POST")
			return reply({ error: "지원하지 않는 요청입니다." }, 405);
		const input = await json();
		if (!id) {
			fields(
				input,
				["ownerAgentId", "title", "cwd", "prompt", "requestId", "model"],
				["ownerAgentId", "title", "cwd", "prompt", "requestId"],
			);
			const ownerAgentId = text(input["ownerAgentId"], 48);
			if (!validOwner(ownerAgentId)) throw Error("Invalid owner");
			const task = await tasks.create({
				ownerAgentId,
				title: text(input["title"], 200),
				cwd: text(input["cwd"], 4096),
				prompt: text(input["prompt"], 16000),
				requestId: text(input["requestId"], 128),
				...(input["model"] === undefined
					? {}
					: { model: text(input["model"], 256) }),
			});
			return reply({ task }, 202);
		}
		if (action === "messages") {
			fields(
				input,
				["text", "requestId", "expectedRevision"],
				["text", "requestId", "expectedRevision"],
			);
			return reply(
				{
					task: await tasks.message(id, {
						text: text(input["text"], 16000),
						requestId: text(input["requestId"], 128),
						expectedRevision: revision(input["expectedRevision"]),
					}),
				},
				202,
			);
		}
		if (action === "interrupt") {
			fields(input, ["expectedRevision"], ["expectedRevision"]);
			return reply({
				task: await tasks.interrupt(id, revision(input["expectedRevision"])),
			});
		}
		if (action === "approval") {
			fields(
				input,
				["approvalId", "decision", "expectedRevision"],
				["approvalId", "decision", "expectedRevision"],
			);
			const decision = input["decision"];
			if (
				decision !== "accept" &&
				decision !== "decline" &&
				decision !== "cancel" &&
				decision !== "acceptForSession"
			)
				throw Error("Invalid decision");
			if (!tasks.reply)
				return reply(
					{ error: "이 연결에서는 승인을 처리할 수 없습니다." },
					503,
				);
			return reply({
				task: await tasks.reply(id, {
					approvalId: text(input["approvalId"], 256),
					decision,
					expectedRevision: revision(input["expectedRevision"]),
				}),
			});
		}
		if (action === "owner") {
			fields(
				input,
				["ownerAgentId", "expectedRevision"],
				["ownerAgentId", "expectedRevision"],
			);
			const ownerAgentId = text(input["ownerAgentId"], 48);
			if (!validOwner(ownerAgentId)) throw Error("Invalid owner");
			return reply({
				task: await tasks.handover(id, {
					ownerAgentId,
					expectedRevision: revision(input["expectedRevision"]),
				}),
			});
		}
		return reply({ error: "지원하지 않는 요청입니다." }, 405);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		const statuses: Record<string, number> = {
			unauthorized: 403,
			unknown_task: 404,
			conflict: 409,
			revision_mismatch: 409,
			native_unavailable: 502,
			native_archived: 409,
			closed: 503,
			approval_unavailable: 409,
		};
		const message = error instanceof Error ? error.message : "";
		const status =
			statuses[code] ??
			(/revision|conflict|stale|busy/i.test(message) &&
			!/Invalid expectedRevision/.test(message)
				? 409
				: 400);
		return reply(
			{
				error:
					status === 404
						? "작업을 찾지 못했습니다."
						: status === 409
							? "작업 상태가 바뀌었습니다. 새로 확인한 뒤 다시 시도해주세요."
							: "작업 요청을 처리하지 못했습니다. 입력과 Codex 연결을 확인해주세요.",
			},
			status,
		);
	}
}
