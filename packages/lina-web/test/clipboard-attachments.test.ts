import { afterEach, expect, test } from "bun:test";

// Keep DOM globals out of the Bun root program; the browser build checks the
// renderer against lib.dom. This harness describes only its public boundary.
type Attachments = {
	port: { value: string };
	busy: boolean;
	blocked: boolean;
	update(online: boolean): void;
	dispose(): void;
};
const moduleUrl = new URL(
	"../../lina-ui/client/attachments.ts",
	import.meta.url,
);
const { createAttachments } = (await import(moduleUrl.href)) as {
	createAttachments(
		input: Node,
		session: () => string | undefined,
		changed: () => void,
		notice: (message: string) => void,
	): Attachments;
};

class Node extends EventTarget {
	children: Node[] = [];
	attributes = new Map<string, string>();
	value = "";
	textContent = "";
	className = "";
	hidden = false;
	disabled = false;
	files: File[] = [];
	selectionStart = 0;
	selectionEnd = 0;
	append(...nodes: Node[]) {
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: Node[]) {
		this.children = nodes;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	click() {
		this.dispatchEvent(new Event("click"));
	}
	focus() {}
	setRangeText(text: string, start: number, end: number) {
		this.value = this.value.slice(0, start) + text + this.value.slice(end);
		this.selectionStart = this.selectionEnd = start + text.length;
	}
}

const session = "12345678-1234-4234-8234-123456789012";
const ref = { id: "87654321-1234-4234-8234-123456789012", name: "one.txt" };
const file = (name = "one.txt", type = "text/plain") =>
	new File(["sample"], name, { type, lastModified: 1 });
let restore = () => {};
afterEach(() => restore());

function harness() {
	const nodes = new Map(
		["message", "draft-files", "file-picker", "attach-file"].map((id) => [
			id,
			new Node(),
		]),
	);
	const get = (id: string) => {
		const node = nodes.get(id);
		if (!node) throw Error(id);
		return node;
	};
	const uploads: {
		init: RequestInit;
		resolve: (response: Response) => void;
	}[] = [];
	let signal = Promise.withResolvers<void>();
	let changes = 0;
	let changedHook = () => {};
	const changed = () => {
		changes++;
		signal.resolve();
		signal = Promise.withResolvers<void>();
		changedHook();
	};
	const notices: string[] = [];
	const globals: Record<string, unknown> = {
		document: { getElementById: get, createElement: () => new Node() },
		HTMLDivElement: Node,
		HTMLInputElement: Node,
		HTMLButtonElement: Node,
		fetch: (_url: string, init: RequestInit) =>
			new Promise<Response>((resolve) => uploads.push({ init, resolve })),
	};
	const descriptors = new Map(
		Object.keys(globals).map((key) => [
			key,
			Object.getOwnPropertyDescriptor(globalThis, key),
		]),
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	restore = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const input = get("message");
	// Minimal DOM stand-in; browser build separately checks the actual DOM contract.
	const attachments = createAttachments(
		input,
		() => session,
		changed,
		(message) => notices.push(message),
	);
	const restoreGlobals = restore;
	restore = () => {
		attachments.dispose();
		restoreGlobals();
	};
	attachments.update(true);
	const waitFor = async (check: () => boolean) => {
		while (!check()) await signal.promise;
	};
	const pick = (...files: File[]) => {
		const picker = get("file-picker");
		picker.files = files;
		picker.dispatchEvent(new Event("change"));
	};
	const paste = (files: File[], text = "", fallback = files) => {
		const event = Object.assign(new Event("paste", { cancelable: true }), {
			clipboardData: {
				items: files.map((value) => ({ kind: "file", getAsFile: () => value })),
				files: fallback,
				getData: (type: string) =>
					type === "text/plain" ? text : "<img src=x onerror=bad()>",
			},
		});
		input.dispatchEvent(event);
		return event;
	};
	return {
		input,
		attachments,
		uploads,
		notices,
		get,
		pick,
		paste,
		waitFor,
		changes: () => changes,
		onChange: (hook: () => void) => {
			changedHook = hook;
		},
	};
}

test("parent update callbacks do not recurse or replace unchanged attachment rows", async () => {
	const h = harness();
	h.onChange(() => h.attachments.update(true));
	expect(h.changes()).toBe(0);
	h.pick(file());
	const uploading = h.get("draft-files").children[0];
	for (let i = 0; i < 100; i++) h.attachments.update(true);
	expect(h.changes()).toBe(1);
	expect(h.get("draft-files").children[0]).toBe(uploading);
	expect(h.uploads).toHaveLength(1);
	h.uploads[0]?.resolve(new Response(null, { status: 507 }));
	await h.waitFor(() => !h.attachments.busy);
	expect(h.changes()).toBe(2);
	const failed = h.get("draft-files").children[0];
	for (let i = 0; i < 100; i++) h.attachments.update(true);
	expect(h.get("draft-files").children[0]).toBe(failed);
	expect(h.changes()).toBe(2);
	expect(h.uploads).toHaveLength(1);
});

test("picker additions during upload remain visible and queued", () => {
	const h = harness();
	h.pick(file());
	h.pick(file("two.txt"));
	expect(h.get("draft-files").children).toHaveLength(2);
	expect(h.uploads).toHaveLength(1);
	expect(h.get("attach-file").disabled).toBe(false);
});

test("mixed file/text paste replaces the selection once, emits input, and deduplicates items/files", () => {
	const h = harness();
	h.input.value = "before selected after";
	h.input.selectionStart = 7;
	h.input.selectionEnd = 15;
	let inputs = 0;
	h.input.addEventListener("input", () => {
		inputs++;
	});
	const event = h.paste([file()], "한글\ntext");
	expect(event.defaultPrevented).toBe(true);
	expect(h.input.value).toBe("before 한글\ntext after");
	expect(inputs).toBe(1);
	expect(h.get("draft-files").children).toHaveLength(1);
	expect(h.uploads).toHaveLength(1);
});

test("plain text, URL and local path paste leave native editing untouched", () => {
	const h = harness();
	h.input.value = "keep";
	let inputs = 0;
	h.input.addEventListener("input", () => {
		inputs++;
	});
	for (const text of [
		"한글\ntext",
		"https://example.com/a.png",
		"/home/example/a.png",
	]) {
		expect(h.paste([], text).defaultPrevented).toBe(false);
	}
	expect(h.input.value).toBe("keep");
	expect(inputs).toBe(0);
	expect(h.uploads).toHaveLength(0);
});

test("files fallback and unnamed images use the same picker/paste queue without deduping later pastes", () => {
	const h = harness();
	const png = file("", "image/png");
	h.paste([], "", [png]);
	h.paste([png]);
	h.paste([file("", "image/jpeg")]);
	expect(h.get("draft-files").children).toHaveLength(3);
	expect(
		new Headers(h.uploads[0]?.init.headers).get("X-Lina-Filename"),
	).toMatch(/\.png$/);
});

test("resetting the draft aborts upload and a late receipt cannot contaminate the new draft", async () => {
	const h = harness();
	h.pick(file());
	const upload = h.uploads[0];
	if (!upload) throw Error("missing upload");
	h.attachments.port.value = "new draft";
	expect(upload.init.signal?.aborted).toBe(true);
	h.pick(file("new.txt"));
	upload.resolve(Response.json(ref));
	h.uploads[1]?.resolve(
		Response.json({
			...ref,
			id: "87654321-1234-4234-8234-123456789013",
			name: "new.txt",
		}),
	);
	await h.waitFor(() => !h.attachments.busy);
	expect(h.attachments.port.value).toBe(
		`new draft\n\n[new.txt](/api/attachments/87654321-1234-4234-8234-123456789013?sessionId=${session})`,
	);
	expect(h.get("draft-files").children).toHaveLength(1);
});

test("clipboard file items are authoritative even when files exposes extra wrappers", () => {
	const h = harness();
	const first = file();
	h.paste([first], "", [file(), file("other.txt")]);
	expect(h.get("draft-files").children).toHaveLength(1);
	// Different copies with the same metadata remain distinct within one source.
	h.paste([first, file()], "", [first, file()]);
	expect(h.get("draft-files").children).toHaveLength(3);
});

test("one paste with different lastModified wrappers uploads once; a later paste stays separate", async () => {
	const h = harness();
	const item = new File(["png bytes"], "image.png", {
		type: "image/png",
		lastModified: 1,
	});
	const wrapper = new File(["png bytes"], "image.png", {
		type: "image/png",
		lastModified: 2,
	});
	h.paste([item], "", [wrapper]);
	expect(h.get("draft-files").children).toHaveLength(1);
	h.uploads[0]?.resolve(Response.json({ ...ref, name: "image.png" }));
	await h.waitFor(() => !h.attachments.busy);
	expect(h.uploads).toHaveLength(1);
	expect(
		h.get("draft-files").children[0]?.getAttribute("data-attachment-state"),
	).toBe("ready");
	h.paste([item], "", [wrapper]);
	expect(h.get("draft-files").children).toHaveLength(2);
	expect(h.uploads).toHaveLength(2);
});

test.each([
	[413, "2 MiB"],
	[507, "저장 공간"],
	[500, "저장소 오류"],
	[400, "형식"],
] as const)(
	"HTTP %i leaves a recoverable file with the appropriate reason",
	async (status, expected) => {
		const h = harness();
		h.pick(file());
		h.uploads[0]?.resolve(new Response(null, { status }));
		await h.waitFor(() => !h.attachments.busy);
		expect(h.attachments.blocked).toBe(true);
		const row = h.get("draft-files").children[0];
		expect(row?.getAttribute("data-attachment-state")).toBe("error");
		expect(
			row?.children.find((node) => node.getAttribute("role") === "alert")
				?.textContent,
		).toContain(expected);
		const retry = row?.children.find((node) =>
			node.getAttribute("aria-label")?.endsWith("재시도"),
		);
		expect(retry?.disabled).toBe(false);
		retry?.click();
		expect(h.uploads).toHaveLength(2);
		h.uploads[1]?.resolve(Response.json(ref));
		await h.waitFor(() => !h.attachments.busy);
		expect(h.attachments.blocked).toBe(false);
		expect(h.attachments.port.value).toContain(
			`[one.txt](/api/attachments/${ref.id}?sessionId=${session})`,
		);
		const ready = h.get("draft-files").children[0];
		expect(ready?.children.some((node) => node.textContent === "준비됨")).toBe(
			true,
		);
		ready?.children
			.find((node) => node.getAttribute("aria-label")?.endsWith("제외"))
			?.click();
		expect(h.attachments.port.value).toBe("");
	},
);

test("2 MiB is accepted; a larger file stays visible as an error and can be excluded", async () => {
	const h = harness();
	h.pick(
		new File([new Uint8Array(2097152)], "fits.png", { type: "image/png" }),
	);
	expect(h.uploads).toHaveLength(1);
	h.pick(
		new File([new Uint8Array(2097153)], "large.png", { type: "image/png" }),
	);
	h.uploads[0]?.resolve(Response.json({ ...ref, name: "fits.png" }));
	await h.waitFor(() => !h.attachments.busy);
	expect(h.uploads).toHaveLength(1);
	expect(
		h
			.get("draft-files")
			.children.map((node) => node.getAttribute("data-attachment-state")),
	).toEqual(["ready", "error"]);
	expect(h.attachments.blocked).toBe(true);
	h.get("draft-files")
		.children[1]?.children.find((node) =>
			node.getAttribute("aria-label")?.endsWith("제외"),
		)
		?.click();
	expect(h.attachments.blocked).toBe(false);
});

test("a malformed JSON receipt displays a recovery action without exposing parser errors", async () => {
	const h = harness();
	h.pick(file());
	h.uploads[0]?.resolve(new Response("<html>server error</html>"));
	await h.waitFor(() => !h.attachments.busy);
	const error = h
		.get("draft-files")
		.children[0]?.children.find(
			(node) => node.getAttribute("role") === "alert",
		);
	expect(error?.textContent).toBe(
		"첨부 결과 미확인 · 재시도 또는 제외해 주세요.",
	);
	expect(h.attachments.blocked).toBe(true);
});

test.each([
	{},
	{ id: "invalid", name: "bad.txt" },
	{ ...ref, name: "../../bad.txt" },
])("invalid receipts never become uploaded draft links: %j", async (meta) => {
	const h = harness();
	h.pick(file());
	h.uploads[0]?.resolve(Response.json(meta));
	await h.waitFor(() => !h.attachments.busy);
	expect(h.attachments.port.value).toBe("");
	expect(h.attachments.blocked).toBe(true);
	expect(
		h.get("draft-files").children[0]?.getAttribute("data-attachment-state"),
	).toBe("error");
});
