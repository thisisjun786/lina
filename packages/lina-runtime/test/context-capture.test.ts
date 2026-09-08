import { expect, test } from "bun:test";
import { join } from "node:path";
import { publicIdentity } from "../../lina-memory/src/honcho/config.ts";
import { HonchoOutbox } from "../../lina-memory/src/honcho/index.ts";
import {
	ordinaryNamespace,
	qualifiedConfig,
} from "../../lina-memory/test/honcho-fixture.ts";
import { scanCaptures } from "../src/context/capture-scan.ts";
import { qualifyRequest } from "./context-honcho-fixture.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("capture scan survives paging/restart and excludes unsettled turns, tools, reasoning and probes", async () => {
	const f = createRuntimeFixture(),
		file = join(f.root, "outbox.sqlite");
	const identity = publicIdentity(qualifiedConfig);
	const options = {
		ordinaryNamespace,
		sourceLookup: (id: string) => f.store.sourceEntry(id),
	};
	let outbox = new HonchoOutbox(file, f.runtime.binding, identity, options);
	const append = (
		id: string,
		role: "user" | "assistant" | "tool" | "meta",
		text: string,
		message: unknown = {},
	) =>
		f.store.appendEntry({
			entryId: id,
			role,
			text,
			timestamp: "2026-09-05T00:00:00Z",
			raw: { type: "message", message },
		});
	try {
		append("user", "user", "Keep the blue preference", {
			role: "user",
			content: "Keep the blue preference",
		});
		f.store.createRequest("request", "Keep the blue preference");
		f.store.setRequest("request", "accepted", { entryId: "user" });
		qualifyRequest(f.store, f.runtime.binding, "request", ["user"]);
		scanCaptures(f.store, outbox, 1);
		expect(outbox.counts().pending).toBe(0);
		expect(outbox.scanState().after).toBe(0);
		f.store.setRequest("request", "settled");
		scanCaptures(f.store, outbox, 1);
		expect(outbox.counts().pending).toBe(1);
		outbox.close();
		outbox = new HonchoOutbox(file, f.runtime.binding, identity, options);
		append("assistant", "assistant", "Saved decision.", {
			role: "assistant",
			stopReason: "stop",
			content: [
				{ type: "text", text: "Saved decision." },
				{ type: "thinking", thinking: "PRIVATE" },
			],
		});
		qualifyRequest(f.store, f.runtime.binding, "request", ["assistant"]);
		append("tool", "tool", "Do not capture tool output");
		append("probe", "user", "Internal retrieval query", {
			role: "user",
			content: "Internal retrieval query",
		});
		append("probe-reply", "assistant", "Internal inference", {
			role: "assistant",
			stopReason: "stop",
		});
		scanCaptures(f.store, outbox);
		expect(outbox.counts().pending).toBe(2);
		expect(
			outbox
				.next()
				.map((part) => part.content)
				.join("\n"),
		).not.toContain("PRIVATE");
		scanCaptures(f.store, outbox);
		expect(outbox.counts().pending).toBe(2);
	} finally {
		outbox.close();
		await f.close();
	}
});
