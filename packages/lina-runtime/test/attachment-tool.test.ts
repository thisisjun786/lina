import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import { createAttachmentTool } from "../src/tools/attachments.ts";

test("attachment read is bound to its store and active request, with a total per-request budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-file-tool-"));
	const binding = {
		version: 1 as const,
		botId: "lina",
		workspace: root,
		sessionFile: join(root, "native.jsonl"),
		sessionId: "12345678-1234-4234-8234-123456789012",
	};
	const store = new AttachmentStore(join(root, "files"), binding);
	try {
		const meta = store.put(
			"note.txt",
			new TextEncoder().encode("가".repeat(22000)),
		);
		let owner: string | undefined = "request-1";
		const tool = createAttachmentTool(store, () => owner);
		const signal = new AbortController().signal;
		let total = 0,
			offset = 0;
		for (let i = 0; i < 4; i++) {
			try {
				const response = await tool.execute(
					"read",
					{ id: meta.id, offset },
					signal,
				);
				const part = response.content[0];
				total += part?.type === "text" ? part.text.length : 0;
				const next = response.details.nextOffset;
				if (next === null) break;
				offset = next;
			} catch {
				break;
			}
		}
		expect(total).toBeGreaterThan(10000);
		expect(total).toBeLessThanOrEqual(16384);
		await expect(
			tool.execute("over", { id: meta.id, offset }, signal),
		).rejects.toThrow("budget");
		owner = undefined;
		await expect(tool.execute("none", { id: meta.id }, signal)).rejects.toThrow(
			"owner",
		);
		owner = "request-2";
		expect(
			(await tool.execute("again", { id: meta.id }, signal)).details.nextOffset,
		).toBeGreaterThan(0);
		await expect(
			tool.execute("bad", { id: "../../secret" }, signal),
		).rejects.toThrow();
		await expect(
			tool.execute("abort", { id: meta.id }, AbortSignal.abort()),
		).rejects.toThrow();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
