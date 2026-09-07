import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageJobStore } from "../src/images/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function setup() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-store-"));
	roots.push(root);
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "a80be8ed-a493-4e88-8523-b5f85d73d652",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	return { root, binding };
}
const input = {
	requestId: "chat-1",
	callId: "call-1",
	provider: "fixture",
	model: "image-one",
	prompt: "A blue circle",
	sourceArtifactId: null,
};
test("image jobs persist before dispatch, deduplicate the original call and reject conflicts", () => {
	const { root, binding } = setup();
	const first = new ImageJobStore(root, binding);
	const job = first.create(input);
	expect(job.state).toBe("prepared");
	const second = new ImageJobStore(root, binding);
	expect(second.create(input)).toEqual(job);
	expect(() => second.create({ ...input, prompt: "different" })).toThrow(
		"conflict",
	);
	expect(second.list()).toHaveLength(1);
	expect(() => new ImageJobStore(root, { ...binding, botId: "other" })).toThrow(
		"binding",
	);
});
test("states and provenance survive restart without returning mutable records", () => {
	const { root, binding } = setup();
	const first = new ImageJobStore(root, binding);
	const job = first.create(input);
	first.update(job.id, {
		state: "uncertain",
		endpoint: "http://127.0.0.1:45678",
		runtimeVersion: "3.14.0",
		error: "Outcome unknown",
	});
	const second = new ImageJobStore(root, binding);
	const restored = second.get(job.id);
	expect(restored).toMatchObject({
		state: "uncertain",
		provider: "fixture",
		model: "image-one",
		requestId: "chat-1",
		error: "Outcome unknown",
	});
	restored.state = "failed";
	expect(second.get(job.id).state).toBe("uncertain");
	expect(() => second.get("../foreign")).toThrow();
});

test("an image record cannot claim a different artifact ID", () => {
	const { root, binding } = setup();
	const store = new ImageJobStore(root, binding);
	const job = store.create(input);
	expect(() =>
		store.update(job.id, {
			state: "completed",
			artifact: {
				id: "22222222-2222-4222-8222-222222222222",
				name: "result.png",
				mime: "image/png",
				size: 1,
				sha256: "a".repeat(64),
			},
		}),
	).toThrow("artifact");
	expect(store.get(job.id).state).toBe("prepared");
});
