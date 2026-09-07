import { agentRequest, type RequestFn } from "./agent-editor.ts";
import type { SettingsDocument, SettingsNode } from "./model-settings.ts";

type TaskNode = SettingsNode & {
	open?: boolean;
	showModal?: () => void;
	close?: () => void;
};

const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const LIVE_REFRESH_MS = 3000;
const RUNNING = new Set([
	"inProgress",
	"running",
	"queued",
	"creating",
	"waiting_approval",
	"waiting_input",
	"needs_attention",
]);

export type TaskApproval = {
	id: string;
	method: string;
	params: unknown;
	createdAt: string;
};

export type ApprovalDecision =
	| "accept"
	| "decline"
	| "cancel"
	| "acceptForSession";

export type TaskRecord = {
	id: string;
	threadId: string | null;
	ownerAgentId: string;
	title: string;
	cwd: string;
	status: string;
	revision: number;
	updatedAt: string;
	model: string | null;
	pendingApprovals: TaskApproval[];
};

export type HistoryRow = {
	kind: "user" | "assistant" | "status" | "tool" | "error";
	text: string;
};

export type TaskThreadItem = Record<string, unknown> & { type: string };

export type TaskTurn = {
	id: string;
	status: string;
	error: { message?: string } | null;
	items: TaskThreadItem[];
};

export type TaskThread = {
	id?: string;
	turns?: TaskTurn[];
};

export type TaskDetail = {
	task: TaskRecord;
	thread: TaskThread | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string") throw Error("작업 정보가 올바르지 않습니다.");
	return value;
}

function nullableString(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	if (value === null) return null;
	if (typeof value !== "string") throw Error("작업 정보가 올바르지 않습니다.");
	return value;
}

function parseApprovals(value: unknown): TaskApproval[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw Error("작업 정보가 올바르지 않습니다.");
	return value.map((item) => {
		const rec = asRecord(item);
		if (!rec) throw Error("작업 정보가 올바르지 않습니다.");
		return {
			id: requiredString(rec, "id"),
			method: requiredString(rec, "method"),
			params: rec["params"],
			createdAt: requiredString(rec, "createdAt"),
		};
	});
}

export function parseTask(value: unknown): TaskRecord {
	const record = asRecord(value);
	if (!record) throw Error("작업 정보가 올바르지 않습니다.");
	const id = requiredString(record, "id");
	if (!TASK_ID.test(id)) throw Error("작업 정보가 올바르지 않습니다.");
	const revision = record["revision"];
	if (
		typeof revision !== "number" ||
		!Number.isInteger(revision) ||
		revision < 0
	)
		throw Error("작업 정보가 올바르지 않습니다.");
	return {
		id,
		threadId: nullableString(record, "threadId"),
		ownerAgentId: requiredString(record, "ownerAgentId"),
		title: requiredString(record, "title"),
		cwd: requiredString(record, "cwd"),
		status: requiredString(record, "status"),
		revision,
		updatedAt: requiredString(record, "updatedAt"),
		model: nullableString(record, "model"),
		pendingApprovals: parseApprovals(record["pendingApprovals"]),
	};
}

export function parseTaskList(value: unknown): TaskRecord[] {
	const record = asRecord(value);
	const tasks = record?.["tasks"];
	if (!Array.isArray(tasks)) throw Error("작업 목록이 올바르지 않습니다.");
	return tasks.map(parseTask);
}

function parseTurn(value: unknown): TaskTurn {
	const record = asRecord(value);
	if (!record) throw Error("작업 이력이 올바르지 않습니다.");
	const items = record["items"];
	const errorValue = record["error"];
	const errorRecord = asRecord(errorValue);
	return {
		id: requiredString(record, "id"),
		status: requiredString(record, "status"),
		error:
			errorValue === null
				? null
				: {
						...(typeof errorRecord?.["message"] === "string"
							? { message: errorRecord["message"] }
							: {}),
					},
		items: Array.isArray(items)
			? items.flatMap((item) => {
					const rec = asRecord(item);
					return rec && typeof rec["type"] === "string"
						? [{ ...rec, type: rec["type"] }]
						: [];
				})
			: [],
	};
}

function parseOptionalThread(value: unknown): TaskThread | null {
	if (value === null) return null;
	const threadRecord = asRecord(value);
	const turns = threadRecord?.["turns"];
	return {
		...(typeof threadRecord?.["id"] === "string"
			? { id: threadRecord["id"] }
			: {}),
		...(Array.isArray(turns) ? { turns: turns.map(parseTurn) } : {}),
	};
}

export function parseTaskDetail(value: unknown): TaskDetail {
	const record = asRecord(value);
	if (!record) throw Error("작업을 불러오지 못했습니다.");
	return {
		task: parseTask(record["task"]),
		thread: Object.hasOwn(record, "thread")
			? parseOptionalThread(record["thread"])
			: null,
	};
}

export function taskDeepLink(threadId: string): string {
	return `codex://threads/${encodeURIComponent(threadId)}`;
}

function userText(item: Record<string, unknown>): string {
	if (typeof item["text"] === "string") return item["text"];
	const content = item["content"];
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const rec = asRecord(part);
			return rec && rec["type"] === "text" && typeof rec["text"] === "string"
				? rec["text"]
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

export function compactThreadHistory(thread: TaskThread | null): HistoryRow[] {
	const rows: HistoryRow[] = [];
	for (const turn of thread?.turns ?? []) {
		if (turn.status === "failed" && turn.error?.message)
			rows.push({ kind: "error", text: turn.error.message });
		for (const item of turn.items ?? []) {
			if (item.type === "userMessage") {
				const text = userText(item);
				if (text) rows.push({ kind: "user", text });
			} else if (item.type === "agentMessage") {
				const text = typeof item["text"] === "string" ? item["text"] : "";
				if (text) rows.push({ kind: "assistant", text });
			} else if (
				item.type === "commandExecution" ||
				item.type === "mcpToolCall" ||
				item.type === "dynamicToolCall" ||
				item.type === "functionCallOutput"
			) {
				const status = typeof item["status"] === "string" ? item["status"] : "";
				rows.push({
					kind: "tool",
					text: status ? `도구 호출 · ${status}` : "도구 호출",
				});
			} else if (item.type === "plan" && typeof item["text"] === "string")
				rows.push({ kind: "status", text: item["text"] });
		}
	}
	return rows;
}

export function taskStatusLabel(status: string): string {
	if (status === "inProgress" || status === "running") return "진행 중";
	if (status === "waiting_approval") return "확인 대기";
	if (status === "waiting_input") return "입력 대기";
	if (status === "needs_attention") return "확인 필요";
	if (status === "creating") return "만드는 중";
	if (status === "completed") return "완료";
	if (status === "interrupted") return "중단됨";
	if (status === "failed") return "실패";
	if (status === "queued" || status === "idle") return "대기";
	return status;
}

export function approvalMethodLabel(method: string): string {
	if (method.includes("commandExecution") || method === "execCommandApproval")
		return "명령 실행";
	if (method.includes("fileChange") || method === "applyPatchApproval")
		return "파일 변경";
	return "확인 요청";
}

function approvalField(
	record: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (
			Array.isArray(value) &&
			value.every((item) => typeof item === "string") &&
			value.length
		)
			return value.join(" ");
	}
}

function approvalFiles(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) {
		const rec = asRecord(value);
		if (!rec) return [];
		const path = approvalField(rec, ["path", "filename", "file", "uri"]);
		return path ? [path] : [];
	}
	return value.flatMap(approvalFiles);
}

export function approvalDetails(params: unknown): string {
	const record = asRecord(params);
	if (!record) return "요청 내용을 확인하세요.";
	const lines: string[] = [];
	const command = approvalField(record, ["command", "cmd", "argv"]);
	const cwd = approvalField(record, ["cwd", "workdir", "workingDirectory"]);
	const reason = approvalField(record, ["reason", "explanation", "message"]);
	if (command) lines.push(command);
	if (cwd) lines.push(cwd);
	if (reason) lines.push(reason);
	const files = approvalFiles(
		record["fileChanges"] ??
			record["changes"] ??
			record["files"] ??
			record["diffs"],
	);
	lines.push(...files.slice(0, 8));
	if (files.length > 8) lines.push(`외 ${files.length - 8}개 파일`);
	if (lines.length) return lines.join("\n");
	for (const [key, value] of Object.entries(record)) {
		if (/id$/i.test(key) || key === "threadId" || key === "turnId") continue;
		if (typeof value === "string" && value.trim()) lines.push(value.trim());
	}
	return lines.length ? lines.join("\n") : "요청 내용을 확인하세요.";
}

function requestId(): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function")
		return cryptoApi.randomUUID();
	return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function browserDocument(): SettingsDocument {
	const doc = (globalThis as { document?: SettingsDocument }).document;
	if (!doc) throw Error("Task panel requires a document");
	return doc;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function installTasks(options: {
	ownerAgentId: string;
	document?: SettingsDocument;
	request?: RequestFn;
	hidden?: () => boolean;
	scheduler?: (tick: () => void) => () => void;
}) {
	const doc = options.document ?? browserDocument();
	const request = options.request ?? agentRequest;
	const find = (id: string): TaskNode => {
		const node = doc.getElementById(id);
		if (!node) throw Error(`Missing interface element: ${id}`);
		return node;
	};
	const list = find("task-list");
	const status = find("tasks-status");
	const add = find("add-task");
	const reload = find("task-reload");
	const dialog = find("task-dialog");
	const heading = find("task-heading");
	const taskStatus = find("task-status");
	const meta = find("task-meta");
	const errorNode = find("task-error");
	const history = find("task-history");
	const approvals = find("task-approvals");
	const openLink = find("task-open-codex");
	const createForm = find("task-create");
	const title = find("task-title");
	const cwd = find("task-cwd");
	const prompt = find("task-prompt");
	const model = find("task-model");
	const createSubmit = find("task-create-submit");
	const chat = find("task-chat");
	const input = find("task-input");
	const send = find("task-send");
	const interrupt = find("task-interrupt");
	const owner = find("task-owner");
	const handover = find("task-handover");
	let generation = 0,
		busy = false,
		tasks: TaskRecord[] = [],
		detail: TaskDetail | null = null,
		mode: "create" | "detail" = "create",
		selectedId: string | null = null,
		returnFocus: TaskNode | undefined,
		listSeq = 0,
		detailSeq = 0,
		stopped = false,
		liveGate: Promise<void> | undefined,
		liveQueued = false,
		listSignature = "";
	openLink.setAttribute("target", "_blank");
	openLink.setAttribute("rel", "noopener noreferrer");
	openLink.textContent = "Codex에서 열기";
	const controls = () => {
		const current = detail?.task;
		const running = !!current && RUNNING.has(current.status);
		add.disabled = busy;
		reload.disabled = busy;
		createSubmit.disabled = busy;
		send.disabled = busy || mode !== "detail" || !input.value.trim();
		interrupt.disabled = busy || !running;
		handover.disabled = busy || !current;
		for (const node of approvals.querySelectorAll("button"))
			node.disabled = busy;
	};
	const showDialog = () => {
		if (dialog.open) return;
		if (dialog.showModal) dialog.showModal();
		else dialog.open = true;
	};
	const pageHidden = () => {
		if (options.hidden) return options.hidden();
		if (options.document) return false;
		return Boolean(
			(globalThis as { document?: { hidden?: boolean } }).document?.hidden,
		);
	};
	const restoreFocus = () => {
		if (
			returnFocus &&
			(returnFocus === add ||
				returnFocus === reload ||
				list.contains(returnFocus))
		) {
			returnFocus.focus();
			return;
		}
		const opener = selectedId
			? doc.getElementById(`task-open-${selectedId}`)
			: null;
		if (opener) {
			opener.focus();
			return;
		}
		reload.focus();
	};
	const dismiss = () => {
		generation++;
		listSeq++;
		detailSeq++;
		busy = false;
		controls();
		restoreFocus();
	};
	const hideDialog = () => {
		if (!dialog.open) return;
		if (dialog.close) dialog.close();
		else {
			dialog.open = false;
			dismiss();
		}
	};
	const renderList = () => {
		const signature = JSON.stringify(
			tasks.map((task) => [task.id, task.title, task.status]),
		);
		if (signature === listSignature) return;
		listSignature = signature;
		const active = (doc as SettingsDocument & { activeElement?: TaskNode })
			.activeElement;
		const focusId = active && list.contains(active) ? active.id : undefined;
		list.replaceChildren();
		for (const task of tasks) {
			const button = doc.createElement("button");
			button.type = "button";
			button.id = `task-open-${task.id}`;
			button.className = "task-link sidebar-label";
			button.textContent = `${task.title} · ${taskStatusLabel(task.status)}`;
			button.setAttribute("aria-label", task.title);
			button.addEventListener("click", () => {
				returnFocus = button;
				return openTask(task.id);
			});
			list.append(button);
		}
		if (focusId) doc.getElementById(focusId)?.focus();
	};
	const renderHistory = (thread: TaskThread | null) => {
		history.replaceChildren();
		const rows = compactThreadHistory(thread);
		if (!rows.length) {
			const empty = doc.createElement("p");
			empty.className = "task-empty";
			empty.textContent = "아직 턴이 없습니다.";
			history.append(empty);
			return;
		}
		for (const row of rows) {
			const node = doc.createElement("p");
			node.className = `task-row task-row-${row.kind}`;
			node.textContent = row.text;
			history.append(node);
		}
	};
	const renderDetail = () => {
		const current = detail?.task;
		createForm.hidden = mode !== "create";
		chat.hidden = mode !== "detail";
		if (mode === "create") {
			heading.textContent = "작업 추가";
			taskStatus.textContent = "";
			meta.textContent = "";
			openLink.hidden = true;
			openLink.setAttribute("href", "");
			history.replaceChildren();
			approvals.replaceChildren();
			controls();
			return;
		}
		if (!current) {
			heading.textContent = "작업";
			meta.textContent = "";
			openLink.hidden = true;
			openLink.setAttribute("href", "");
			history.replaceChildren();
			approvals.replaceChildren();
			controls();
			return;
		}
		heading.textContent = current.title;
		taskStatus.textContent = taskStatusLabel(current.status);
		meta.textContent = `${current.ownerAgentId} · ${current.cwd} · ${current.model} · r${current.revision}`;
		const href = current.threadId ? taskDeepLink(current.threadId) : "";
		openLink.hidden = !href;
		openLink.setAttribute("href", href);
		renderHistory(detail?.thread ?? null);
		renderApprovals(current);
		controls();
	};
	const renderApprovals = (current: TaskRecord) => {
		approvals.replaceChildren();
		for (const item of current.pendingApprovals) {
			const card = doc.createElement("article");
			card.className = "task-approval";
			const title = doc.createElement("strong");
			title.textContent = approvalMethodLabel(item.method);
			const details = doc.createElement("pre");
			details.className = "task-approval-details";
			details.textContent = approvalDetails(item.params);
			const actions = doc.createElement("div");
			actions.className = "task-approval-actions";
			const choices: Array<[ApprovalDecision, string]> = [
				["accept", "허용"],
				["decline", "거절"],
				["acceptForSession", "이 세션 동안 허용"],
				["cancel", "요청 취소"],
			];
			for (const [decision, label] of choices) {
				const button = doc.createElement("button");
				button.type = "button";
				button.className =
					decision === "accept" || decision === "decline"
						? "secondary-button"
						: "text-button";
				button.textContent = label;
				button.disabled = busy;
				button.addEventListener(
					"click",
					() => void replyApproval(item.id, decision),
				);
				actions.append(button);
			}
			card.append(title, details, actions);
			approvals.append(card);
		}
	};
	const loadAgents = async (selected: string) => {
		owner.replaceChildren();
		let rows: Array<{ id: string; name: string }> = [
			{ id: options.ownerAgentId, name: options.ownerAgentId },
		];
		try {
			const value = asRecord(await request("/api/agents"));
			const agents = value?.["agents"];
			if (Array.isArray(agents))
				rows = agents.flatMap((item) => {
					const rec = asRecord(item);
					if (!rec) return [];
					const id = rec["id"];
					if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(id))
						return [];
					const name = rec["name"];
					return [
						{
							id,
							name: typeof name === "string" && name.trim() ? name : id,
						},
					];
				});
		} catch {
			/* Keep the current owner so handover remains possible. */
		}
		if (!rows.some((row) => row.id === selected))
			rows.unshift({ id: selected, name: selected });
		for (const row of rows) {
			const option = doc.createElement("option");
			option.value = row.id;
			option.textContent = row.name;
			owner.append(option);
		}
		owner.value = selected;
	};
	const refresh = async (quiet = false) => {
		const mine = ++listSeq;
		if (!quiet) {
			generation++;
			busy = true;
			controls();
			status.textContent = "작업 목록을 불러오는 중…";
		}
		try {
			const next = parseTaskList(await request("/api/tasks"));
			if (mine !== listSeq) return;
			tasks = next;
			renderList();
			if (!quiet || !tasks.length)
				status.textContent = tasks.length
					? ""
					: "작업이 없습니다. 새 작업을 추가하세요.";
		} catch (error) {
			if (mine !== listSeq) return;
			if (quiet) return;
			tasks = [];
			renderList();
			status.textContent = message(error, "작업 목록을 불러오지 못했습니다.");
		} finally {
			if (!quiet && mine === listSeq) {
				busy = false;
				controls();
			}
		}
	};
	const openCreate = () => {
		generation++;
		detailSeq++;
		mode = "create";
		selectedId = null;
		detail = null;
		errorNode.textContent = "";
		title.value = "";
		cwd.value = "";
		prompt.value = "";
		model.value = "";
		returnFocus = add;
		renderDetail();
		showDialog();
		title.focus();
	};
	const openTask = async (id: string) => {
		const mine = ++generation;
		const load = ++detailSeq;
		busy = true;
		mode = "detail";
		selectedId = id;
		detail = null;
		renderDetail();
		errorNode.textContent = "";
		taskStatus.textContent = "불러오는 중…";
		showDialog();
		controls();
		try {
			const next = parseTaskDetail(
				await request(`/api/tasks/${encodeURIComponent(id)}`),
			);
			if (mine !== generation || load !== detailSeq) return;
			detail = next;
			await loadAgents(next.task.ownerAgentId);
			if (mine !== generation || load !== detailSeq) return;
			renderDetail();
		} catch (error) {
			if (mine !== generation || load !== detailSeq) return;
			errorNode.textContent = message(error, "작업을 불러오지 못했습니다.");
			taskStatus.textContent = "";
		} finally {
			if (mine === generation && load === detailSeq) {
				busy = false;
				controls();
			}
		}
	};
	const applyDetail = (value: unknown, preserveDraft = false) => {
		const record = asRecord(value);
		if (!record) throw Error("작업을 불러오지 못했습니다.");
		const task = parseTask(record["task"]);
		const thread = Object.hasOwn(record, "thread")
			? parseOptionalThread(record["thread"])
			: (detail?.thread ?? null);
		const draft = input.value;
		const ownerDraft = owner.value;
		const ownerEdited = !!detail && ownerDraft !== detail.task.ownerAgentId;
		detail = { task, thread };
		selectedId = task.id;
		tasks = tasks.map((item) => (item.id === task.id ? task : item));
		if (!tasks.some((item) => item.id === task.id)) tasks = [task, ...tasks];
		renderList();
		renderDetail();
		if (preserveDraft) {
			input.value = draft;
			if (ownerEdited && ownerDraft) owner.value = ownerDraft;
			else owner.value = task.ownerAgentId;
			controls();
		}
	};
	const reconcileSelected = async () => {
		const id = selectedId;
		if (!id || mode !== "detail" || !dialog.open || busy) return;
		const mine = detailSeq;
		const known = detail?.task;
		try {
			const next = parseTaskDetail(
				await request(`/api/tasks/${encodeURIComponent(id)}`),
			);
			if (mine !== detailSeq || selectedId !== id || !dialog.open || busy)
				return;
			if (detail && next.task.revision < detail.task.revision) return;
			if (
				known &&
				next.task.revision === known.revision &&
				JSON.stringify(next.thread) === JSON.stringify(detail?.thread)
			) {
				tasks = tasks.map((item) =>
					item.id === next.task.id ? next.task : item,
				);
				renderList();
				return;
			}
			applyDetail(next, true);
		} catch {
			/* Live refresh stays quiet; the last rendered task remains visible. */
		}
	};
	const sync = async () => {
		if (stopped || pageHidden() || busy) return;
		if (liveGate) {
			liveQueued = true;
			return liveGate;
		}
		liveGate = (async () => {
			try {
				do {
					liveQueued = false;
					await refresh(true);
					if (stopped || pageHidden()) return;
					await reconcileSelected();
				} while (liveQueued && !stopped && !pageHidden());
			} finally {
				liveGate = undefined;
			}
		})();
		await liveGate;
	};
	const createTask = async () => {
		if (busy) return;
		const nextTitle = title.value.trim();
		const nextCwd = cwd.value.trim();
		const nextPrompt = prompt.value.trim();
		if (!nextTitle || !nextCwd || !nextPrompt) {
			errorNode.textContent = "제목, 작업 폴더, 첫 지시를 입력하세요.";
			return;
		}
		const mine = ++generation;
		busy = true;
		errorNode.textContent = "";
		controls();
		try {
			const body: {
				ownerAgentId: string;
				title: string;
				cwd: string;
				prompt: string;
				requestId: string;
				model?: string;
			} = {
				ownerAgentId: options.ownerAgentId,
				title: nextTitle,
				cwd: nextCwd,
				prompt: nextPrompt,
				requestId: requestId(),
			};
			if (model.value.trim()) body.model = model.value.trim();
			const created = parseTaskDetail(
				await request("/api/tasks", "POST", body),
			);
			if (mine !== generation) return;
			detail = created;
			mode = "detail";
			selectedId = created.task.id;
			await loadAgents(created.task.ownerAgentId);
			if (mine !== generation) return;
			tasks = [
				created.task,
				...tasks.filter((task) => task.id !== created.task.id),
			];
			status.textContent = "";
			renderList();
			renderDetail();
		} catch (error) {
			if (mine !== generation) return;
			errorNode.textContent = message(error, "작업을 만들지 못했습니다.");
		} finally {
			if (mine === generation) {
				busy = false;
				controls();
			}
		}
	};
	const sendMessage = async () => {
		const current = detail?.task;
		const text = input.value.trim();
		if (busy || !current || !text) return;
		const mine = ++generation;
		detailSeq++;
		listSeq++;
		busy = true;
		errorNode.textContent = "";
		controls();
		try {
			const value = await request(
				`/api/tasks/${encodeURIComponent(current.id)}/messages`,
				"POST",
				{
					text,
					requestId: requestId(),
					expectedRevision: current.revision,
				},
			);
			if (mine !== generation) return;
			applyDetail(value);
			if (mine !== generation) return;
			input.value = "";
		} catch (error) {
			if (mine !== generation) return;
			errorNode.textContent = message(error, "메시지를 보내지 못했습니다.");
		} finally {
			if (mine === generation) {
				busy = false;
				controls();
			}
		}
	};
	const interruptTask = async () => {
		const current = detail?.task;
		if (busy || !current) return;
		const mine = ++generation;
		detailSeq++;
		listSeq++;
		busy = true;
		errorNode.textContent = "";
		controls();
		try {
			const value = await request(
				`/api/tasks/${encodeURIComponent(current.id)}/interrupt`,
				"POST",
				{ expectedRevision: current.revision },
			);
			if (mine !== generation) return;
			applyDetail(value);
		} catch (error) {
			if (mine !== generation) return;
			errorNode.textContent = message(error, "작업을 중단하지 못했습니다.");
		} finally {
			if (mine === generation) {
				busy = false;
				controls();
			}
		}
	};
	const replyApproval = async (
		approvalId: string,
		decision: ApprovalDecision,
	) => {
		const current = detail?.task;
		if (busy || !current) return;
		const mine = ++generation;
		detailSeq++;
		listSeq++;
		busy = true;
		errorNode.textContent = "";
		controls();
		try {
			const value = await request(
				`/api/tasks/${encodeURIComponent(current.id)}/approval`,
				"POST",
				{
					approvalId,
					decision,
					expectedRevision: current.revision,
				},
			);
			if (mine !== generation) return;
			applyDetail(value);
		} catch (error) {
			if (mine !== generation) return;
			errorNode.textContent = message(error, "승인을 처리하지 못했습니다.");
		} finally {
			if (mine === generation) {
				busy = false;
				controls();
			}
		}
	};
	const handoverTask = async () => {
		const current = detail?.task;
		const ownerAgentId = owner.value.trim();
		if (busy || !current || !ownerAgentId) return;
		const mine = ++generation;
		detailSeq++;
		listSeq++;
		busy = true;
		errorNode.textContent = "";
		controls();
		try {
			const value = await request(
				`/api/tasks/${encodeURIComponent(current.id)}/owner`,
				"POST",
				{
					ownerAgentId,
					expectedRevision: current.revision,
				},
			);
			if (mine !== generation) return;
			applyDetail(value);
		} catch (error) {
			if (mine !== generation) return;
			errorNode.textContent = message(error, "담당을 넘기지 못했습니다.");
		} finally {
			if (mine === generation) {
				busy = false;
				controls();
			}
		}
	};
	add.addEventListener("click", openCreate);
	reload.addEventListener("click", () => void refresh());
	createSubmit.addEventListener("click", () => void createTask());
	send.addEventListener("click", () => void sendMessage());
	interrupt.addEventListener("click", () => void interruptTask());
	handover.addEventListener("click", () => void handoverTask());
	input.addEventListener("input", () => controls());
	const closer = doc.getElementById("task-close");
	closer?.addEventListener("click", () => hideDialog());
	dialog.addEventListener("close", () => dismiss());
	createForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void createTask();
	});
	chat.addEventListener("submit", (event) => {
		event.preventDefault();
		void sendMessage();
	});
	const schedule =
		options.scheduler ??
		(options.document
			? undefined
			: (tick: () => void) => {
					const timer = setInterval(tick, LIVE_REFRESH_MS);
					return () => clearInterval(timer);
				});
	const stopLive = schedule?.(() => {
		void sync();
	});
	const closeLive = () => {
		stopped = true;
		listSeq++;
		detailSeq++;
		generation++;
		busy = false;
		stopLive?.();
	};
	return {
		refresh,
		sync,
		close() {
			closeLive();
		},
	};
}
