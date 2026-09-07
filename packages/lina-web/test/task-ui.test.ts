import { expect, test } from "bun:test";
import {
	approvalDetails,
	approvalMethodLabel,
	compactThreadHistory,
	installTasks,
	parseTaskDetail,
	parseTaskList,
	taskDeepLink,
} from "../../lina-ui/client/task-view.ts";

class Node {
	id = "";
	className = "";
	type = "";
	hidden = false;
	scrollTop = 0;
	attributes = new Map<string, string>();
	setAttribute(k: string, v: string) {
		this.attributes.set(k, v);
	}
	removeAttribute(k: string) {
		this.attributes.delete(k);
	}
	contains(n: unknown): boolean {
		return this === n || this.children.some((c) => c.contains(n));
	}
	select() {}
	scrollIntoView() {}
	disabled = false;
	open = false;
	focused = false;
	min = "";
	max = "";
	step = "";
	checked = false;
	parent?: Node;
	children: Node[] = [];
	private text = "";
	private selected = "";
	listeners = new Map<
		string,
		Array<
			(event: {
				key?: string;
				relatedTarget?: unknown;
				preventDefault(): void;
				stopPropagation(): void;
			}) => unknown
		>
	>();
	constructor(readonly tag: string) {}
	get textContent(): string {
		return this.text + this.children.map((node) => node.textContent).join("");
	}
	set textContent(value: string) {
		this.text = value;
		this.children = [];
	}
	get value(): string {
		return (
			this.selected ||
			(this.tag === "select" ? (this.children[0]?.value ?? "") : this.text)
		);
	}
	set value(value: string) {
		this.selected = value;
		if (this.tag === "textarea" || this.tag === "input") this.text = value;
	}
	append(...nodes: Node[]) {
		for (const node of nodes) {
			if (node.parent)
				node.parent.children = node.parent.children.filter(
					(item) => item !== node,
				);
			node.parent = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: Node[]) {
		this.children = [];
		this.selected = "";
		this.text = "";
		this.append(...nodes);
	}
	after(...nodes: Node[]) {
		if (!this.parent) return;
		const parent = this.parent;
		parent.children.splice(parent.children.indexOf(this) + 1, 0, ...nodes);
		for (const node of nodes) node.parent = parent;
	}
	before(...nodes: Node[]) {
		if (!this.parent) return;
		this.parent.children.splice(
			this.parent.children.indexOf(this),
			0,
			...nodes,
		);
		for (const node of nodes) node.parent = this.parent;
	}
	querySelectorAll(tag: string): Node[] {
		return this.children.flatMap((node) => [
			...(node.tag === tag || node.className === tag ? [node] : []),
			...node.querySelectorAll(tag),
		]);
	}
	addEventListener(
		event: string,
		listener: (event: {
			key?: string;
			relatedTarget?: unknown;
			preventDefault(): void;
			stopPropagation(): void;
		}) => unknown,
	) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}
	async fire(event: string, key?: string) {
		await Promise.all(
			(this.listeners.get(event) ?? []).map((listener) =>
				listener({
					...(key ? { key } : {}),
					preventDefault() {},
					stopPropagation() {},
				}),
			),
		);
	}
	checkValidity() {
		return true;
	}
	reportValidity() {
		return true;
	}
	focus() {
		this.focused = true;
	}
	showModal() {
		if (this.open)
			throw Error("InvalidStateError: dialog already open non-modally");
		this.open = true;
	}
	close() {
		if (!this.open) throw Error("InvalidStateError: dialog already closed");
		this.open = false;
		for (const listener of this.listeners.get("close") ?? [])
			listener({
				preventDefault() {},
				stopPropagation() {},
			});
	}
}

function walk(node: Node): Node[] {
	return node.children.flatMap((child) => [child, ...walk(child)]);
}

function fixture() {
	const root = new Node("body");
	const make = (id: string, tag = "div") => {
		const node = new Node(tag);
		node.id = id;
		root.append(node);
		return node;
	};
	const tasksDialog = make("tasks-dialog", "section");
	Object.defineProperty(tasksDialog, "showModal", { value: undefined });
	Object.defineProperty(tasksDialog, "close", { value: undefined });
	tasksDialog.hidden = true;

	make("task-list");
	make("tasks-status", "p");
	make("add-task", "button");
	make("task-reload", "button");
	const dialog = make("task-dialog", "dialog");
	make("task-heading", "h2");
	make("task-status", "p");
	make("task-meta", "p");
	make("task-error", "p");
	make("task-history");
	make("task-approvals");
	make("task-open-codex", "a");
	make("task-create", "form");
	make("task-title", "input");
	make("task-cwd", "input");
	make("task-prompt", "textarea");
	make("task-model", "input");
	make("task-create-submit", "button");
	make("task-chat", "form");
	make("task-input", "textarea");
	make("task-send", "button");
	make("task-interrupt", "button");
	make("task-owner", "select");
	make("task-handover", "button");
	make("task-close", "button");
	const find = (id: string): Node => {
		const node = [root, ...walk(root)].find((item) => item.id === id);
		if (!node) throw Error(id);
		return node;
	};
	return {
		root,
		dialog,
		find,
		document: {
			location: { href: "http://fixture/?agent=lina" },
			createElement: (tag: string) => new Node(tag),
			getElementById: (id: string) =>
				[root, ...walk(root)].find((item) => item.id === id) ?? null,
		},
	};
}

const sampleTask = {
	id: "task-1",
	threadId: "thread-abc",
	ownerAgentId: "lina",
	title: "로그 정리",
	cwd: "/tmp/work",
	status: "inProgress",
	revision: 3,
	updatedAt: "2026-09-06T12:00:00.000Z",
	model: "gpt-5",
	pendingApprovals: [],
};

test("task list parsing keeps native fields and builds a Codex deep link", () => {
	expect(parseTaskList({ tasks: [sampleTask] })).toEqual([sampleTask]);
	expect(taskDeepLink("thread-abc")).toBe("codex://threads/thread-abc");
});

test("thread history shows user and assistant text without dumping tool logs", () => {
	const rows = compactThreadHistory({
		id: "thread-abc",
		turns: [
			{
				id: "turn-1",
				status: "completed",
				error: null,
				items: [
					{
						type: "userMessage",
						content: [{ type: "text", text: "로그를 정리해줘" }],
					},
					{
						type: "commandExecution",
						command: "rm -rf /",
						aggregatedOutput: "SECRET_TOOL_LOG",
						status: "completed",
					},
					{ type: "agentMessage", text: "정리를 마쳤습니다." },
				],
			},
		],
	});
	expect(rows.map((row) => row.text).join("\n")).toContain("로그를 정리해줘");
	expect(rows.map((row) => row.text).join("\n")).toContain("정리를 마쳤습니다");
	expect(rows.some((row) => row.kind === "tool")).toBe(true);
	expect(JSON.stringify(rows)).not.toContain("SECRET_TOOL_LOG");
	expect(JSON.stringify(rows)).not.toContain("rm -rf");
});

test("empty and failed task lists stay honest", async () => {
	const empty = fixture();
	const emptyView = installTasks({
		ownerAgentId: "lina",
		document: empty.document,
		request: async () => ({ tasks: [] }),
	});
	await emptyView.refresh();
	expect(empty.find("tasks-status").textContent).toContain("작업이 없습니다");
	expect(empty.find("task-list").children.length).toBe(0);
	const failed = fixture();
	const failedView = installTasks({
		ownerAgentId: "lina",
		document: failed.document,
		request: async () => {
			throw Error("작업 목록을 불러오지 못했습니다.");
		},
	});
	await failedView.refresh();
	expect(failed.find("tasks-status").textContent).toContain(
		"작업 목록을 불러오지 못했습니다",
	);
	expect(failed.find("task-list").children.length).toBe(0);
});

test("task panel sends input, cancel and handover against expected revision", async () => {
	const f = fixture();
	const seen: Array<{ path: string; method: string; body: unknown }> = [];
	let task = { ...sampleTask };
	const detail = {
		task,
		thread: {
			id: task.threadId,
			turns: [
				{
					id: "turn-1",
					status: "inProgress",
					error: null,
					items: [
						{
							type: "userMessage",
							content: [{ type: "text", text: "이어서" }],
						},
						{
							type: "dynamicToolCall",
							tool: "shell",
							arguments: { cmd: "cat secrets" },
							status: "inProgress",
						},
					],
				},
			],
		},
	};
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET", body) => {
			seen.push({ path, method, body });
			if (path === "/api/tasks" && method === "GET") return { tasks: [task] };
			if (path === "/api/tasks" && method === "POST") {
				task = { ...task, id: "task-2", title: "새 작업", revision: 1 };
				return { task, thread: { id: task.threadId, turns: [] } };
			}
			if (path === "/api/tasks/task-1" && method === "GET") return detail;
			if (path === "/api/tasks/task-1/messages") {
				expect(body).toEqual({
					text: "이 방향으로",
					requestId: (body as { requestId: string }).requestId,
					expectedRevision: 3,
				});
				task = { ...task, revision: 4, status: "inProgress" };
				return { task, thread: detail.thread };
			}
			if (path === "/api/tasks/task-1/interrupt") {
				expect(body).toEqual({ expectedRevision: 4 });
				task = { ...task, revision: 5, status: "interrupted" };
				return {
					task,
					thread: {
						...detail.thread,
						turns: [{ ...detail.thread.turns[0], status: "interrupted" }],
					},
				};
			}
			if (path === "/api/tasks/task-1/owner") {
				expect(body).toEqual({
					ownerAgentId: "alpha",
					expectedRevision: 5,
				});
				task = { ...task, revision: 6, ownerAgentId: "alpha" };
				return { task, thread: detail.thread };
			}
			if (path === "/api/agents")
				return {
					agents: [
						{ id: "lina", name: "Lina" },
						{ id: "alpha", name: "Alpha" },
					],
					presets: [],
				};
			throw Error(path);
		},
	});
	await view.refresh();
	expect(f.find("task-list").textContent).toContain("로그 정리");
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	expect(f.dialog.open).toBe(true);
	expect(f.find("task-history").textContent).toContain("이어서");
	expect(f.find("task-history").textContent).not.toContain("cat secrets");
	expect(f.find("task-open-codex").attributes.get("href")).toBe(
		"codex://threads/thread-abc",
	);
	expect(f.find("task-status").textContent).toContain("진행");
	expect(f.find("task-interrupt").disabled).toBe(false);
	f.find("task-input").value = "이 방향으로";
	await f.find("task-send").fire("click");
	await f.find("task-interrupt").fire("click");
	f.find("task-owner").value = "alpha";
	await f.find("task-handover").fire("click");
	expect(f.find("task-status").textContent).not.toContain("진행 중");
	expect(
		seen.some(
			(item) =>
				item.path === "/api/tasks/task-1/messages" && item.method === "POST",
		),
	).toBe(true);
	expect(
		seen.some(
			(item) =>
				item.path === "/api/tasks/task-1/interrupt" && item.method === "POST",
		),
	).toBe(true);
	expect(
		seen.some(
			(item) =>
				item.path === "/api/tasks/task-1/owner" && item.method === "POST",
		),
	).toBe(true);
});

test("creating a task posts owner, title, cwd, prompt and requestId", async () => {
	const f = fixture();
	const seen: unknown[] = [];
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET", body) => {
			if (path === "/api/tasks" && method === "GET") return { tasks: [] };
			if (path === "/api/tasks" && method === "POST") {
				seen.push(body);
				const created = {
					...sampleTask,
					id: "task-new",
					title: "새 작업",
					revision: 1,
					status: "inProgress",
				};
				return { task: created, thread: { id: created.threadId, turns: [] } };
			}
			if (path === "/api/tasks/task-new")
				return parseTaskDetail({
					task: { ...sampleTask, id: "task-new", title: "새 작업" },
					thread: { id: "thread-abc", turns: [] },
				});
			if (path === "/api/agents") return { agents: [], presets: [] };
			throw Error(path);
		},
	});
	await view.refresh();
	await f.find("add-task").fire("click");
	expect(f.dialog.open).toBe(true);
	f.find("task-title").value = "새 작업";
	f.find("task-cwd").value = "/tmp/work";
	f.find("task-prompt").value = "파일을 정리해줘";
	await f.find("task-create-submit").fire("click");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toMatchObject({
		ownerAgentId: "lina",
		title: "새 작업",
		cwd: "/tmp/work",
		prompt: "파일을 정리해줘",
	});
	expect(typeof (seen[0] as { requestId: string }).requestId).toBe("string");
});

test("failed send keeps the typed input and shows the error", async () => {
	const f = fixture();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET", body) => {
			if (path === "/api/tasks" && method === "GET")
				return { tasks: [sampleTask] };
			if (path === "/api/tasks/task-1")
				return {
					task: sampleTask,
					thread: { id: "thread-abc", turns: [] },
				};
			if (path === "/api/agents") return { agents: [], presets: [] };
			if (path.endsWith("/messages")) throw Error("리비전이 바뀌었습니다.");
			return body;
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	f.find("task-input").value = "보내지 못한 내용";
	await f.find("task-send").fire("click");
	expect(f.find("task-input").value).toBe("보내지 못한 내용");
	expect(f.find("task-error").textContent).toContain("리비전이 바뀌었습니다");
});

test("pending approvals show request details and post an explicit accept", async () => {
	const f = fixture();
	const seen: Array<{ path: string; method: string; body: unknown }> = [];
	const waiting = {
		...sampleTask,
		status: "waiting_approval",
		pendingApprovals: [
			{
				id: "rpc:7",
				method: "item/commandExecution/requestApproval",
				params: {
					threadId: "thread-abc",
					turnId: "turn-1",
					itemId: "item-9",
					command: "ls /tmp/work",
					cwd: "/tmp/work",
				},
				createdAt: "2026-09-06T12:00:01.000Z",
			},
		],
	};
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET", body) => {
			seen.push({ path, method, body });
			if (path === "/api/tasks" && method === "GET")
				return { tasks: [waiting] };
			if (path === "/api/tasks/task-1" && method === "GET")
				return { task: waiting, thread: { id: "thread-abc", turns: [] } };
			if (path === "/api/agents") return { agents: [], presets: [] };
			if (path === "/api/tasks/task-1/approval") {
				expect(body).toEqual({
					approvalId: "rpc:7",
					decision: "accept",
					expectedRevision: 3,
				});
				return {
					task: {
						...waiting,
						revision: 4,
						status: "running",
						pendingApprovals: [],
					},
				};
			}
			throw Error(path);
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	expect(f.find("task-approvals").textContent).toContain("명령 실행");
	expect(f.find("task-approvals").textContent).not.toContain(
		"commandExecution",
	);
	expect(f.find("task-approvals").textContent).toContain("ls /tmp/work");
	expect(
		f
			.find("task-approvals")
			.querySelectorAll("button")
			.every((node) => node.disabled === false),
	).toBe(true);
	expect(seen.some((item) => item.path === "/api/tasks/task-1/approval")).toBe(
		false,
	);
	const accept = f
		.find("task-approvals")
		.querySelectorAll("button")
		.find((node) => node.textContent === "허용");
	if (!accept) throw Error("missing accept");
	await accept.fire("click");
	expect(
		seen.some(
			(item) =>
				item.path === "/api/tasks/task-1/approval" &&
				item.method === "POST" &&
				(item.body as { decision: string }).decision === "accept",
		),
	).toBe(true);
	expect(f.find("task-status").textContent).toContain("진행");
	expect(f.find("task-approvals").querySelectorAll("button").length).toBe(0);
});

test("approval copy keeps the command and hides native ids", () => {
	expect(approvalMethodLabel("item/commandExecution/requestApproval")).toBe(
		"명령 실행",
	);
	expect(approvalMethodLabel("item/fileChange/requestApproval")).toBe(
		"파일 변경",
	);
	const text = approvalDetails({
		threadId: "thread-abc",
		turnId: "turn-1",
		itemId: "item-9",
		command: "bun test",
		cwd: "/tmp/work",
		reason: "테스트를 확인하려고",
		changes: [{ path: "app.ts" }, { path: "task-view.ts" }],
	});
	expect(text).toContain("bun test");
	expect(text).toContain("/tmp/work");
	expect(text).toContain("테스트를 확인하려고");
	expect(text).toContain("app.ts");
	expect(text).not.toContain("thread-abc");
	expect(text).not.toContain("turn-1");
	expect(text).not.toContain("item-9");
});

test("loading an existing task does not show the creation form", async () => {
	const f = fixture();
	let release: ((value: unknown) => void) | undefined;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (path === "/api/tasks" && method === "GET")
				return { tasks: [sampleTask] };
			if (path === "/api/tasks/task-1") return pending;
			if (path === "/api/agents") return { agents: [], presets: [] };
			throw Error(path);
		},
	});
	await view.refresh();
	const opening = f
		.find("task-list")
		.querySelectorAll("button")[0]
		?.fire("click");
	expect(f.find("task-create").hidden).toBe(true);
	expect(f.find("task-heading").textContent).not.toBe("작업 추가");
	expect(f.find("task-status").textContent).toContain("불러오는");
	release?.({
		task: sampleTask,
		thread: { id: "thread-abc", turns: [] },
	});
	await opening;
	expect(f.find("task-create").hidden).toBe(true);
	expect(f.find("task-heading").textContent).toBe("로그 정리");
	view.close();
});

test("closing the task dialog restores a live list button after refresh", async () => {
	const f = fixture();
	let title = "로그 정리";
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (path === "/api/tasks" && method === "GET")
				return { tasks: [{ ...sampleTask, title }] };
			if (path === "/api/tasks/task-1")
				return {
					task: { ...sampleTask, title },
					thread: { id: "thread-abc", turns: [] },
				};
			if (path === "/api/agents") return { agents: [], presets: [] };
			throw Error(path);
		},
	});
	await view.refresh();
	const first = f.find("task-list").querySelectorAll("button")[0];
	await first?.fire("click");
	expect(f.dialog.open).toBe(true);
	title = "로그 정리 중";
	await view.sync();
	expect(f.find("task-open-task-1").textContent).toContain("로그 정리 중");
	expect(first && f.find("task-list").contains(first)).toBe(false);
	await f.find("task-close").fire("click");
	expect(f.dialog.open).toBe(false);
	expect(f.find("task-open-task-1").focused).toBe(true);
	view.close();
});

test("live sync updates a changed revision and keeps drafts", async () => {
	const f = fixture();
	let hidden = false;
	let revision = 3;
	let status = "inProgress";
	let history = "처음 지시";
	let pendingApprovals: unknown[] = [];
	const seen: string[] = [];
	let tick: (() => void) | undefined;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		hidden: () => hidden,
		scheduler: (next) => {
			tick = next;
			return () => {
				tick = undefined;
			};
		},
		request: async (path, method = "GET") => {
			seen.push(`${method} ${path}`);
			if (path === "/api/tasks" && method === "GET")
				return {
					tasks: [{ ...sampleTask, revision, status, pendingApprovals }],
				};
			if (path === "/api/tasks/task-1" && method === "GET")
				return {
					task: {
						...sampleTask,
						revision,
						status,
						pendingApprovals,
					},
					thread: {
						id: "thread-abc",
						turns: [
							{
								id: "turn-1",
								status: "inProgress",
								error: null,
								items: [
									{
										type: "userMessage",
										content: [{ type: "text", text: history }],
									},
								],
							},
						],
					},
				};
			if (path === "/api/agents")
				return {
					agents: [
						{ id: "lina", name: "Lina" },
						{ id: "alpha", name: "Alpha" },
					],
					presets: [],
				};
			throw Error(path);
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	f.find("task-input").value = "보내지 않은 초안";
	f.find("task-owner").value = "alpha";
	revision = 8;
	status = "waiting_approval";
	history = "이후 지시";
	pendingApprovals = [
		{
			id: "rpc:9",
			method: "item/commandExecution/requestApproval",
			params: { command: "bun test", cwd: "/tmp/work" },
			createdAt: "2026-09-06T12:01:00.000Z",
		},
	];
	const before = seen.length;
	hidden = true;
	await view.sync();
	expect(seen.length).toBe(before);
	hidden = false;
	tick?.();
	await view.sync();
	expect(f.find("task-status").textContent).toContain("확인 대기");
	expect(f.find("task-history").textContent).toContain("이후 지시");
	expect(f.find("task-approvals").textContent).toContain("bun test");
	expect(f.find("task-input").value).toBe("보내지 않은 초안");
	expect(f.find("task-owner").value).toBe("alpha");
	expect(f.find("task-meta").textContent).toContain("r8");
	const after = seen.length;
	view.close();
	await view.sync();
	expect(seen.length).toBe(after);
});

test("queued live refresh does not keep a stale sidebar list", async () => {
	const f = fixture();
	let release: (() => void) | undefined;
	const first = new Promise<void>((resolve) => {
		release = resolve;
	});
	let lists = 0;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (path === "/api/tasks" && method === "GET") {
				lists += 1;
				const n = lists;
				if (n === 1) await first;
				return {
					tasks: [
						{
							...sampleTask,
							title: n === 1 ? "이전 목록" : "최신 목록",
						},
					],
				};
			}
			throw Error(path);
		},
	});
	const a = view.sync();
	const b = view.sync();
	release?.();
	await a;
	await b;
	expect(f.find("task-list").textContent).toContain("최신 목록");
	expect(f.find("task-list").textContent).not.toContain("이전 목록");
	view.close();
});

test("unchanged live lists preserve the existing focusable task button", async () => {
	const f = fixture();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async () => ({ tasks: [sampleTask] }),
	});
	await view.refresh();
	const button = f.find("task-list").querySelectorAll("button")[0];
	await view.sync();
	expect(f.find("task-list").querySelectorAll("button")[0]).toBe(button);
	view.close();
});

test("external handover updates the owner selector when there is no owner draft", async () => {
	const f = fixture();
	let task = { ...sampleTask };
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path) => {
			if (path === "/api/tasks") return { tasks: [task] };
			if (path === "/api/agents")
				return {
					agents: [
						{ id: "lina", name: "리나" },
						{ id: "kai", name: "카이" },
					],
				};
			return { task, thread: { turns: [] } };
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	task = { ...task, ownerAgentId: "kai", revision: task.revision + 1 };
	await view.sync();
	expect(f.find("task-owner").value).toBe("kai");
	view.close();
});

for (const action of ["messages", "interrupt", "owner", "approval"]) {
	test(`late ${action} response cannot replace a different open task`, async () => {
		const f = fixture();
		const gate = Promise.withResolvers<unknown>();
		const called = Promise.withResolvers<void>();
		const one = {
			...sampleTask,
			title: "첫 작업",
			pendingApprovals: [
				{
					id: "approval",
					method: "item/commandExecution/requestApproval",
					params: { command: "pwd" },
					createdAt: "2026-09-06T00:00:00Z",
				},
			],
		};
		const two = { ...sampleTask, id: "task-2", title: "둘째 작업" };
		const view = installTasks({
			ownerAgentId: "lina",
			document: f.document,
			request: async (path, method = "GET") => {
				if (method === "POST") {
					called.resolve();
					return gate.promise;
				}
				if (path === "/api/tasks") return { tasks: [one, two] };
				if (path === "/api/agents")
					return {
						agents: [
							{ id: "lina", name: "리나" },
							{ id: "kai", name: "카이" },
						],
					};
				return {
					task: path.endsWith("task-2") ? two : one,
					thread: { turns: [] },
				};
			},
		});
		await view.refresh();
		await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
		f.find("task-input").value = "보내기";
		f.find("task-owner").value = "kai";
		const control =
			action === "approval"
				? f.find("task-approvals").querySelectorAll("button")[0]
				: f.find(
						action === "messages"
							? "task-send"
							: action === "interrupt"
								? "task-interrupt"
								: "task-handover",
					);
		await control?.fire("click");
		await called.promise;
		await f.find("task-close").fire("click");
		await f.find("task-list").querySelectorAll("button")[1]?.fire("click");
		gate.resolve({ task: { ...one, title: "늦게 온 첫 작업", revision: 20 } });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(f.find("task-heading").textContent).toBe("둘째 작업");
		view.close();
	});
}

test("a stale live read cannot undo a newer handover response", async () => {
	const f = fixture();
	const read = Promise.withResolvers<unknown>();
	const reading = Promise.withResolvers<void>();
	let reads = 0;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (method === "POST")
				return { task: { ...sampleTask, ownerAgentId: "kai", revision: 20 } };
			if (path === "/api/tasks") return { tasks: [sampleTask] };
			if (path === "/api/agents")
				return {
					agents: [
						{ id: "lina", name: "리나" },
						{ id: "kai", name: "카이" },
					],
				};
			if (++reads === 2) {
				reading.resolve();
				return read.promise;
			}
			return { task: sampleTask, thread: { turns: [] } };
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	const sync = view.sync();
	await reading.promise;
	f.find("task-owner").value = "kai";
	await f.find("task-handover").fire("click");
	read.resolve({ task: { ...sampleTask, revision: 4 }, thread: { turns: [] } });
	await sync;
	expect(f.find("task-meta").textContent).toContain("r20");
	view.close();
});

test("live detail fills new turn history even when its summary revision was already received", async () => {
	const f = fixture();
	let revision = 3;
	let sent = false;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (method === "POST") {
				sent = true;
				revision = 4;
				return { task: { ...sampleTask, revision } };
			}
			if (path === "/api/tasks")
				return { tasks: [{ ...sampleTask, revision }] };
			if (path === "/api/agents") return { agents: [] };
			return {
				task: { ...sampleTask, revision },
				thread: {
					turns: [
						{
							id: "turn",
							status: "inProgress",
							error: null,
							items: [
								{
									type: "userMessage",
									content: [
										{
											type: "text",
											text: sent ? "새로 보낸 메시지" : "처음 메시지",
										},
									],
								},
							],
						},
					],
				},
			};
		},
	});
	await view.refresh();
	await f.find("task-list").querySelectorAll("button")[0]?.fire("click");
	f.find("task-input").value = "새로 보낸 메시지";
	await f.find("task-send").fire("click");
	await view.sync();
	expect(f.find("task-history").textContent).toContain("새로 보낸 메시지");
	view.close();
});

const otherTask = {
	...sampleTask,
	id: "task-2",
	threadId: "other-native-thread",
	ownerAgentId: "kai",
	title: "카이 작업",
};
const taskAgents = {
	agents: [
		{ id: "lina", name: "리나" },
		{ id: "kai", name: "카이" },
	],
};

test("task list defaults to selected owner and all scope follows actual owners", async () => {
	const f = fixture();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path) => {
			if (path === "/api/agents") return taskAgents;
			expect(path).toBe("/api/tasks");
			return {
				tasks: [
					sampleTask,
					otherTask,
					{
						...sampleTask,
						id: "unknown",
						ownerAgentId: "gone",
						title: "남은 작업",
					},
				],
			};
		},
	});
	await view.showList();
	expect(f.find("tasks-dialog").hidden).toBe(false);
	expect(f.find("task-list").querySelectorAll("button")).toHaveLength(1);
	expect(f.find("task-scope").textContent).toContain("담당: 리나");
	await view.setScope("all");
	expect(f.find("task-list").querySelectorAll("button")).toHaveLength(3);
	expect(f.find("task-open-task-2").textContent).toContain("카이");
	expect(f.find("task-open-unknown").textContent).toContain("담당 미지정");
	await view.setOwner("kai");
	expect(f.find("task-scope").value).toBe("all");
	expect(f.find("task-list").querySelectorAll("button")).toHaveLength(3);
	f.find("task-scope").value = "selected";
	await f.find("task-scope").fire("change");
	expect(f.find("task-list").querySelectorAll("button")).toHaveLength(1);
	expect(f.find("task-list").textContent).toContain("카이 작업");
	view.close();
});

test("detail back retains list scope scroll and task-specific input and owner drafts", async () => {
	const f = fixture();
	const events: string[] = [];
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		onShowList: () => events.push("list"),
		onOpen: (id) => events.push(id),
		request: async (path) => {
			if (path === "/api/agents") return taskAgents;
			if (path === "/api/tasks") return { tasks: [sampleTask, otherTask] };
			return {
				task: path.endsWith("task-2") ? otherTask : sampleTask,
				thread: null,
			};
		},
	});
	await view.setScope("all");
	await view.showList();
	f.find("task-list").scrollTop = 120;
	await view.open("task-1");
	f.find("task-input").value = "첫 작업 초안";
	f.find("task-owner").value = "kai";
	await view.refresh();
	await view.showList();
	expect(f.dialog.open).toBe(false);
	expect(f.find("task-list").scrollTop).toBe(120);
	expect(f.find("task-scope").value).toBe("all");
	await view.open("task-2");
	expect(f.find("task-input").value).toBe("");
	f.find("task-input").value = "둘째 초안";
	await view.open("task-1");
	expect(f.find("task-input").value).toBe("첫 작업 초안");
	expect(f.find("task-owner").value).toBe("kai");
	expect(f.find("task-open-codex").attributes.get("href")).toBe(
		"codex://threads/thread-abc",
	);
	await f.find("task-close").fire("click");
	expect(events.at(-1)).toBe("list");
	expect(events).toContain("task-2");
	view.close();
});

test("owner switch discards stale list and agent-directory responses", async () => {
	const f = fixture();
	const oldTasks = Promise.withResolvers<unknown>();
	const oldAgents = Promise.withResolvers<unknown>();
	let lists = 0;
	let agents = 0;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path) => {
			if (path === "/api/agents")
				return ++agents === 1 ? oldAgents.promise : taskAgents;
			return ++lists === 1
				? oldTasks.promise
				: { tasks: [sampleTask, otherTask] };
		},
	});
	const old = view.refresh();
	await view.setOwner("kai");
	oldTasks.resolve({ tasks: [] });
	oldAgents.resolve({ agents: [{ id: "kai", name: "오래된 이름" }] });
	await old;
	expect(f.find("task-list").textContent).toContain("카이 작업");
	expect(f.find("task-scope").textContent).not.toContain("오래된 이름");
	view.close();
});

test("scope switch invalidates pending detail and a late mutation without losing drafts", async () => {
	const f = fixture();
	const detail = Promise.withResolvers<unknown>();
	const mutation = Promise.withResolvers<unknown>();
	const sent = Promise.withResolvers<void>();
	let reads = 0;
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET") => {
			if (method === "POST") {
				sent.resolve();
				return mutation.promise;
			}
			if (path === "/api/agents") return taskAgents;
			if (path === "/api/tasks") return { tasks: [sampleTask, otherTask] };
			return ++reads === 1
				? detail.promise
				: { task: sampleTask, thread: null };
		},
	});
	const opening = view.open("task-1");
	await view.setScope("all");
	detail.resolve({ task: { ...sampleTask, title: "늦은 상세" }, thread: null });
	await opening;
	expect(f.dialog.open).toBe(false);
	await view.open("task-1");
	f.find("task-input").value = "보류한 입력";
	const sending = f.find("task-send").fire("click");
	await sent.promise;
	await view.setScope("selected");
	mutation.resolve({
		task: { ...sampleTask, title: "늦은 응답", revision: 20 },
	});
	await sending;
	await view.open("task-1");
	expect(f.find("task-heading").textContent).toBe("로그 정리");
	expect(f.find("task-input").value).toBe("보류한 입력");
	view.close();
});

test("refresh during detail load preserves the active detail and owner selection", async () => {
	const f = fixture();
	const gate = Promise.withResolvers<unknown>();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path) => {
			if (path === "/api/agents") return taskAgents;
			if (path === "/api/tasks") return { tasks: [sampleTask] };
			return gate.promise;
		},
	});
	const opening = view.open("task-1");
	await view.refresh();
	gate.resolve({ task: sampleTask, thread: null });
	await opening;
	expect(f.find("task-heading").textContent).toBe("로그 정리");
	expect(f.find("task-owner").value).toBe("lina");
	expect(f.find("task-interrupt").disabled).toBe(false);
	view.close();
});

test("inline task pane needs no list dialog and closes detail before asynchronous native close events", async () => {
	const f = fixture();
	f.find("tasks-dialog").id = "task-pane";
	const callbacks: string[] = [];
	f.dialog.close = () => {
		f.dialog.open = false;
	};
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		onShowList: () => callbacks.push("list"),
		request: async (path) => {
			if (path === "/api/agents") return taskAgents;
			if (path === "/api/tasks") return { tasks: [sampleTask] };
			return { task: sampleTask, thread: null };
		},
	});
	await view.showList();
	expect(f.find("task-pane").hidden).toBe(false);
	await view.open("task-1");
	await view.showList();
	expect(callbacks).toEqual(["list", "list"]);
	await view.open("task-1");
	await f.dialog.fire("close");
	expect(f.dialog.hidden).toBe(false);
	expect(f.dialog.open).toBe(true);
	expect(callbacks).toEqual(["list", "list"]);
	view.close();
});

test("create uses the newly selected owner even when all tasks are shown", async () => {
	const f = fixture();
	const created = Promise.withResolvers<unknown>();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path, method = "GET", body) => {
			if (method === "POST") {
				created.resolve(body);
				return { task: otherTask };
			}
			if (path === "/api/agents") return taskAgents;
			return { tasks: [] };
		},
	});
	await view.setScope("all");
	await view.setOwner("kai");
	await f.find("add-task").fire("click");
	f.find("task-title").value = "정리";
	f.find("task-cwd").value = "/tmp/work";
	f.find("task-prompt").value = "파일 정리";
	await f.find("task-create-submit").fire("click");
	expect(await created.promise).toMatchObject({ ownerAgentId: "kai" });
	view.close();
});

test("live handover adds a newly discovered owner without dropping an edited owner draft", async () => {
	const f = fixture();
	let task = { ...sampleTask };
	let directory = { agents: [{ id: "lina", name: "리나" }] };
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		request: async (path) => {
			if (path === "/api/agents") return directory;
			if (path === "/api/tasks") return { tasks: [task] };
			return { task, thread: null };
		},
	});
	await view.open("task-1");
	directory = taskAgents;
	task = { ...task, ownerAgentId: "kai", revision: 4 };
	await view.sync();
	expect(
		f
			.find("task-owner")
			.querySelectorAll("option")
			.map((option) => option.value),
	).toContain("kai");
	expect(f.find("task-owner").value).toBe("kai");
	f.find("task-owner").value = "lina";
	task = { ...task, revision: 5 };
	await view.sync();
	expect(f.find("task-owner").value).toBe("lina");
	view.close();
});

test("editing a restored task while its detail loads preserves the edited owner", async () => {
	const f = fixture();
	const values = new Map([
		[
			"lina.task-draft.v1.task-1",
			JSON.stringify({ input: "saved task draft", owner: "kai" }),
		],
	]);
	const pending = Promise.withResolvers<unknown>();
	const view = installTasks({
		ownerAgentId: "lina",
		document: f.document,
		storage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
			removeItem: (key) => {
				values.delete(key);
			},
		},
		request: async (path) =>
			path === "/api/agents" ? taskAgents : pending.promise,
	});
	const opening = view.open("task-1");
	f.find("task-input").value = "edited while loading";
	await f.find("task-input").fire("input");
	pending.resolve({ task: sampleTask, thread: null });
	await opening;
	expect(f.find("task-owner").value).toBe("kai");
	expect(JSON.parse(values.get("lina.task-draft.v1.task-1") ?? "null")).toEqual(
		{ input: "edited while loading", owner: "kai" },
	);
	view.close();
});
