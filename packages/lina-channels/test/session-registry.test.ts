import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryLineError, SessionRegistry } from "../src/session-registry.ts";
import { RegistryEntrySchema } from "../src/types.ts";

async function tempRegistryPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "lina-channels-"));
	return join(dir, "registry.jsonl");
}

describe("SessionRegistry", () => {
	it("returns the recorded entry when looking up by session and by message", async () => {
		const path = await tempRegistryPath();
		const registry = new SessionRegistry(path);
		const entry = RegistryEntrySchema.parse({
			messageId: "msg-1",
			sessionId: "sess-1",
			channel: "discord",
			channelId: "chan-1",
			recordedAt: "2026-09-04T00:00:00.000Z",
		});

		await registry.record(entry);

		const persisted = new SessionRegistry(path);
		expect(await persisted.lookupByMessage(entry.messageId)).toEqual(entry);
		expect(await persisted.lookupBySession(entry.sessionId)).toEqual([entry]);
	});

	it("skips the malformed line and reports it when the jsonl file contains invalid data", async () => {
		const path = await tempRegistryPath();
		const valid = RegistryEntrySchema.parse({
			messageId: "msg-2",
			sessionId: "sess-2",
			channel: "telegram",
			channelId: "chan-2",
			recordedAt: "2026-09-04T00:00:01.000Z",
		});
		await writeFile(path, `${JSON.stringify(valid)}\nnot-json\n`, "utf8");

		const registry = new SessionRegistry(path);
		expect(await registry.lookupByMessage(valid.messageId)).toEqual(valid);

		const errors = registry.errors();
		expect(errors).toHaveLength(1);
		const error = errors[0];
		expect(error).toBeInstanceOf(RegistryLineError);
		if (error instanceof RegistryLineError) {
			expect(error.line).toBe("not-json");
			expect(error.lineNumber).toBe(2);
		}
	});
});
