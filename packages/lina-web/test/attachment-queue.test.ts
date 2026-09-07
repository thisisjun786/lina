import { expect, test } from "bun:test";
import {
	AttachmentDraft,
	attachmentLink,
	type DraftAttachment,
} from "../../lina-client/src/attachment-draft.ts";
import { AttachmentQueue } from "../../lina-client/src/attachment-queue.ts";

const firstSession = "12345678-1234-4234-8234-123456789012";
const secondSession = "12345678-1234-4234-8234-123456789013";
const file = (name: string) =>
	new File(["sample"], name, { type: "text/plain" });
const receipt = (
	index: number,
	name: string,
	sessionId = firstSession,
): DraftAttachment => ({
	id: `87654321-1234-4234-8234-${String(index).padStart(12, "0")}`,
	name,
	sessionId,
});
function harness() {
	const draft = new AttachmentDraft();
	let session: string | undefined = firstSession;
	let signal = Promise.withResolvers<void>();
	const requests: {
		file: File;
		owner: string;
		signal: AbortSignal;
		resolve: (ref: DraftAttachment) => void;
		reject: (error: Error) => void;
	}[] = [];
	const notices: string[] = [];
	const queue = new AttachmentQueue(draft, {
		session: () => session,
		text: () => draft.text,
		changed: () => {
			signal.resolve();
			signal = Promise.withResolvers<void>();
		},
		notice: (message) => notices.push(message),
		upload: (file, owner, signal) =>
			new Promise((resolve, reject) =>
				requests.push({ file, owner, signal, resolve, reject }),
			),
	});
	queue.update(true);
	const waitFor = async (check: () => boolean) => {
		while (!check()) await signal.promise;
	};
	const request = (index: number) => {
		const r = requests[index];
		if (!r) throw Error(`missing request ${index}`);
		return r;
	};
	return {
		draft,
		queue,
		requests,
		notices,
		waitFor,
		request,
		session: (value: string | undefined) => {
			session = value;
			queue.update(true);
		},
	};
}

test("one queue accepts picker and paste while busy and preserves all item states", async () => {
	const h = harness();
	h.queue.addFiles([file("one.txt"), file("two.txt")], "picker");
	h.queue.addFiles([file("three.txt")], "paste");
	expect(h.queue.items.map((item) => item.state)).toEqual([
		"uploading",
		"pending",
		"pending",
	]);
	expect(h.queue.busy).toBe(true);
	expect(h.queue.blocked).toBe(true);
	h.request(0).reject(Error("storage unavailable"));
	await h.waitFor(() => h.requests.length === 2);
	expect(h.queue.items.map((item) => item.state)).toEqual([
		"error",
		"uploading",
		"pending",
	]);
	h.request(1).resolve(receipt(2, "two.txt"));
	await h.waitFor(() => h.requests.length === 3);
	h.request(2).resolve(receipt(3, "three.txt"));
	await h.waitFor(() => !h.queue.busy);
	expect(h.queue.blocked).toBe(true);
	expect(h.draft.refs.map((ref) => ref.name)).toEqual(["two.txt", "three.txt"]);
	const failed = h.queue.items[0];
	if (!failed) throw Error("missing failed item");
	h.queue.retry(failed.key);
	h.request(3).resolve(receipt(1, "one.txt"));
	await h.waitFor(() => !h.queue.busy);
	expect(h.queue.items.map((item) => item.state)).toEqual([
		"ready",
		"ready",
		"ready",
	]);
	expect(h.queue.blocked).toBe(false);
	expect(h.draft.refs.map((ref) => ref.name)).toEqual([
		"one.txt",
		"two.txt",
		"three.txt",
	]);
});

test("max four counts ready, errors and queued files and rejects an oversized batch explicitly", async () => {
	const h = harness();
	h.queue.addFiles(
		[file("1.txt"), file("2.txt"), file("3.txt"), file("4.txt")],
		"paste",
	);
	h.request(0).reject(Error("offline"));
	await h.waitFor(() => h.requests.length === 2);
	h.queue.addFiles([file("5.txt")], "picker");
	expect(h.queue.items).toHaveLength(4);
	expect(h.notices.at(-1)).toContain("4개");
	const failed = h.queue.items[0];
	if (!failed) throw Error("missing failed item");
	h.queue.remove(failed.key);
	h.queue.addFiles([file("5.txt"), file("6.txt")], "paste");
	expect(h.queue.items).toHaveLength(3);
	h.queue.addFiles([file("5.txt")], "picker");
	expect(h.queue.items).toHaveLength(4);
	h.queue.reset("");
});

test("reset cancels pending work and ignores stale success and failure within the same session", async () => {
	for (const staleFailure of [false, true]) {
		const h = harness();
		h.queue.addFiles([file("old.txt"), file("never.txt")], "picker");
		h.queue.reset("new draft");
		expect(h.request(0).signal.aborted).toBe(true);
		h.queue.addFiles([file("new.txt")], "paste");
		if (staleFailure) h.request(0).reject(Error("stale failure"));
		else h.request(0).resolve(receipt(1, "old.txt"));
		h.request(1).resolve(receipt(2, "new.txt"));
		await h.waitFor(() => !h.queue.busy);
		expect(h.draft.value).toBe(
			`new draft\n\n${attachmentLink(receipt(2, "new.txt"))}`,
		);
		expect(h.requests.map((r) => r.file.name)).toEqual(["old.txt", "new.txt"]);
		expect(h.notices).toEqual([]);
	}
});

test("session changes abort old uploads, block foreign refs and forbid retry into the new session", async () => {
	const h = harness();
	h.queue.reset(attachmentLink(receipt(1, "saved.txt")));
	h.queue.addFiles([file("old.txt"), file("pending.txt")], "paste");
	h.session(secondSession);
	expect(h.request(0).signal.aborted).toBe(true);
	expect(h.queue.busy).toBe(false);
	expect(h.queue.blocked).toBe(true);
	const old = h.queue.items[1];
	if (!old) throw Error("missing old item");
	h.queue.retry(old.key);
	expect(h.requests).toHaveLength(1);
	h.queue.reset("");
	h.queue.addFiles([file("new.txt")], "picker");
	h.request(0).resolve(receipt(2, "old.txt"));
	h.request(1).resolve(receipt(3, "new.txt", secondSession));
	await h.waitFor(() => !h.queue.busy);
	expect(h.draft.refs).toEqual([receipt(3, "new.txt", secondSession)]);
	expect(h.request(1).owner).toBe(secondSession);
});

test("removing an upload aborts it, advances the queue and ignores its late receipt", async () => {
	const h = harness();
	h.queue.addFiles([file("removed.txt"), file("kept.txt")], "paste");
	const removed = h.queue.items[0];
	if (!removed) throw Error("missing item");
	h.queue.remove(removed.key);
	expect(h.request(0).signal.aborted).toBe(true);
	h.request(0).resolve(receipt(1, "removed.txt"));
	h.request(1).resolve(receipt(2, "kept.txt"));
	await h.waitFor(() => !h.queue.busy);
	expect(h.draft.refs).toEqual([receipt(2, "kept.txt")]);
});

test("disconnect retains files, cancels in-flight upload and requires explicit retry", async () => {
	const h = harness();
	h.queue.addFiles([file("first.txt"), file("second.txt")], "paste");
	h.queue.update(false);
	expect(h.request(0).signal.aborted).toBe(true);
	expect(h.queue.items.map((item) => item.state)).toEqual(["error", "pending"]);
	h.queue.update(true);
	expect(h.requests.map((r) => r.file.name)).toEqual([
		"first.txt",
		"second.txt",
	]);
	h.request(0).resolve(receipt(1, "first.txt"));
	h.request(1).resolve(receipt(2, "second.txt"));
	await h.waitFor(() => !h.queue.busy);
	expect(h.queue.blocked).toBe(true);
	expect(h.draft.refs).toEqual([receipt(2, "second.txt")]);
});

test("restored uploaded references retain exact draft serialization and removal", () => {
	const h = harness();
	const original = `read this\n${attachmentLink(receipt(1, "saved.txt"))}`;
	h.queue.reset(original);
	expect(h.draft.value).toBe(original);
	expect(h.queue.items[0]?.state).toBe("ready");
	expect(h.queue.blocked).toBe(false);
	const saved = h.queue.items[0];
	if (!saved) throw Error("missing saved item");
	h.queue.remove(saved.key);
	expect(h.draft.value).toBe("read this");
});

test("unnamed PNG and JPEG uploads get unique extensions without altering bytes", async () => {
	const h = harness();
	h.queue.addFiles(
		[
			new File(["png bytes"], "", { type: "image/png" }),
			new File(["jpeg bytes"], "", { type: "image/jpeg" }),
			new File(["png bytes"], "", { type: "image/png" }),
		],
		"paste",
	);
	for (const [index, extension, bytes] of [
		[0, ".png", "png bytes"],
		[1, ".jpg", "jpeg bytes"],
		[2, ".png", "png bytes"],
	] as const) {
		const request = h.request(index);
		expect(request.file.name.endsWith(extension)).toBe(true);
		expect(await request.file.text()).toBe(bytes);
		request.resolve(receipt(index + 1, request.file.name));
		await h.waitFor(() =>
			index === 2 ? !h.queue.busy : h.requests.length === index + 2,
		);
	}
	expect(new Set(h.requests.map((request) => request.file.name)).size).toBe(3);
});
