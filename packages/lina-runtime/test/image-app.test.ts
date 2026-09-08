import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCodexJournal } from "../../lina-codex/src/identity.ts";
import { type ImageJob, ImageJobStore } from "../src/images/store.ts";
import {
	createImageAppFixture,
	EDITED_PNG,
	GENERATED_PNG,
} from "./image-app-fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test("real image app persists a native notice and reuses the saved image after restart", async () => {
	const fixture = await createImageAppFixture();
	cleanup.push(() => fixture.close());
	expect(fixture.app.images).toBeDefined();
	const firstRequest = await fixture.submit("generate");
	const first = fixture.app.images?.list()[0];
	if (!first?.artifact) throw Error("Generated attachment missing");
	expect(first.state).toBe("completed");
	expect(first.requestId).toBe(firstRequest);
	expect(first.sourceArtifactId).toBeNull();
	expect(fixture.app.attachments.bytes(first.artifact.id)).toEqual(
		GENERATED_PNG,
	);
	expect(fixture.ima2.submissions).toHaveLength(1);
	expect(fixture.ima2.submissions[0]?.body).toEqual({
		requestId: first.id,
		provider: "api",
		model: "image-model",
		prompt: "generate",
		async: true,
		n: 1,
		references: [],
		format: "png",
	});
	expect(fixture.ima2.submissions[0]?.idempotencyKey).toBe(first.id);
	expect(fixture.rpc.calls.map((call) => call.tool)).toEqual([
		"lina_image_generate",
	]);
	const binding = fixture.app.binding;
	const expectedText = `이미지를 만들었습니다.\n\n![생성 이미지](/api/attachments/${first.artifact.id}/preview?sessionId=${binding.sessionId})\n\n[이미지 다운로드](/api/attachments/${first.artifact.id}?sessionId=${binding.sessionId})`;
	const notice = fixture.app.runtime
		.snapshot()
		.messages.find((m) => m.text === expectedText);
	expect(notice?.role).toBe("assistant");
	expect(notice?.entryId ?? null).toBe(first.deliveredEntryId);
	expect(loadCodexJournal(binding.sessionFile)).toContainEqual(
		expect.objectContaining({
			type: "custom_message",
			id: first.deliveredEntryId,
			content: expectedText,
			details: { jobId: `image_${first.id}`, terminalRevision: 1 },
		}),
	);
	const previewPath = `/api/attachments/${first.artifact.id}/preview?sessionId=${binding.sessionId}`;
	const preview = await fetch(
		`http://127.0.0.1:${fixture.app.port}${previewPath}`,
	);
	expect(preview.status).toBe(200);
	expect(preview.headers.get("Content-Type")).toBe("image/png");
	expect(new Uint8Array(await preview.arrayBuffer())).toEqual(GENERATED_PNG);
	const foreign = await fetch(
		`http://127.0.0.1:${fixture.app.port}/api/attachments/${first.artifact.id}/preview?sessionId=${randomUUID()}`,
	);
	expect(foreign.status).toBe(403);
	await foreign.arrayBuffer();

	// Simulate a crash after the native journal write but before recording delivery.
	await fixture.app.stop();
	const manifestPath = join(dirname(binding.sessionFile), "images/jobs.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		jobs: ImageJob[];
	};
	const unacknowledged = manifest.jobs.find((job) => job.id === first.id);
	if (!unacknowledged) throw Error("Interrupted image job missing");
	// Fault injection models the pre-acknowledgement disk snapshot. The v2 store
	// deliberately refuses to clear a committed delivery receipt through update().
	unacknowledged.deliveredEntryId = null;
	unacknowledged.delivery = { kind: "pending" };
	writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
	const interruptedStore = new ImageJobStore(
		dirname(binding.sessionFile),
		binding,
	);
	expect(interruptedStore.get(first.id).deliveredEntryId).toBeNull();
	await fixture.restart();
	expect(fixture.app.binding).toEqual(binding);
	expect(fixture.rpc.methods).toContain("thread/resume");
	expect(fixture.rpc.methods).not.toContain("thread/start");
	expect(fixture.native.history()).toContainEqual(
		expect.objectContaining({
			id: first.deliveredEntryId,
			content: expectedText,
		}),
	);
	await fixture.app.images?.recover();
	await fixture.app.images?.flushNotices();
	expect(
		fixture.app.runtime
			.snapshot()
			.messages.filter((m) => m.text === expectedText),
	).toHaveLength(1);
	const recovered = fixture.app.images?.get(first.id);
	if (!recovered) throw Error("Recovered image job missing");
	expect(recovered).toEqual({ ...first, updatedAt: expect.any(String) });
	expect(fixture.app.images?.list()).toHaveLength(1);
	expect(fixture.ima2.submissions).toHaveLength(1);
	const restoredPreview = await fetch(
		`http://127.0.0.1:${fixture.app.port}${previewPath}`,
	);
	expect(restoredPreview.status).toBe(200);
	expect(new Uint8Array(await restoredPreview.arrayBuffer())).toEqual(
		GENERATED_PNG,
	);

	const editRequest = await fixture.submit("edit");
	const edit = fixture.app.images?.list()[1];
	if (!edit?.artifact) throw Error("Edited attachment missing");
	expect(edit.state).toBe("completed");
	expect(edit.requestId).toBe(editRequest);
	expect(edit.sourceArtifactId).toBe(first.artifact.id);
	expect(edit.artifact.id).not.toBe(first.artifact.id);
	expect(
		fixture.app.runtime
			.snapshot()
			.messages.find((m) => m.entryId === edit.deliveredEntryId)?.text,
	).toBe(
		`이미지를 수정했습니다.\n\n![생성 이미지](/api/attachments/${edit.artifact.id}/preview?sessionId=${binding.sessionId})\n\n[이미지 다운로드](/api/attachments/${edit.artifact.id}?sessionId=${binding.sessionId})`,
	);
	expect(fixture.app.attachments.bytes(first.artifact.id)).toEqual(
		GENERATED_PNG,
	);
	expect(fixture.app.attachments.bytes(edit.artifact.id)).toEqual(EDITED_PNG);
	expect(fixture.ima2.submissions).toHaveLength(2);
	expect(fixture.ima2.submissions[1]?.body.references).toEqual([
		`data:image/png;base64,${Buffer.from(GENERATED_PNG).toString("base64")}`,
	]);
	expect(fixture.rpc.calls.map((call) => call.tool)).toEqual([
		"lina_image_jobs",
		"lina_image_edit",
	]);
	await fixture.restart();
	await fixture.app.images?.recover();
	expect(fixture.ima2.submissions).toHaveLength(2);
	expect(fixture.app.images?.list()).toEqual([recovered, edit]);
	expect(
		fixture.app.runtime
			.snapshot()
			.messages.filter((m) => m.entryId.startsWith("notice-")),
	).toHaveLength(2);
	expect(
		loadCodexJournal(binding.sessionFile).filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				entry.type === "custom_message",
		),
	).toHaveLength(2);
}, 15_000);

test("failed image generation records one failure notice without creating an attachment", async () => {
	const fixture = await createImageAppFixture();
	cleanup.push(() => fixture.close());
	expect(fixture.app.images).toBeDefined();
	await fixture.submit("generate fail");
	const failed = fixture.app.images?.list()[0];
	expect(failed?.state).toBe("failed");
	expect(failed?.artifact).toBeNull();
	expect(failed?.deliveredEntryId).toBeString();
	expect(fixture.rpc.calls[0]?.result.success).toBe(false);
	expect(fixture.ima2.downloads).toHaveLength(0);
	const notices = fixture.app.runtime
		.snapshot()
		.messages.filter((m) => m.entryId.startsWith("notice-"));
	expect(notices).toHaveLength(1);
	expect(notices[0]?.text).toContain("이미지를 만들지 못했습니다.");
	await fixture.restart();
	await fixture.app.images?.recover();
	expect(fixture.ima2.submissions).toHaveLength(1);
	expect(
		fixture.app.runtime
			.snapshot()
			.messages.filter((m) => m.entryId.startsWith("notice-")),
	).toEqual(notices);
}, 15_000);
