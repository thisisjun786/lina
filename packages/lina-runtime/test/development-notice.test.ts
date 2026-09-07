import { expect, test } from "bun:test";
import { projectNativeEntry } from "../src/sdk-events.ts";

test("unowned or malformed custom messages do not become assistant notices", () => {
	const raw = {
		id: "entry",
		type: "custom_message",
		timestamp: "2026-09-05T00:00:00Z",
		customType: "lina.development",
		display: true,
		content: "Job result",
		details: { jobId: "job-1", terminalRevision: 1 },
	};
	expect(projectNativeEntry(raw)).toMatchObject({
		role: "assistant",
		text: "Job result",
	});
	expect(projectNativeEntry({ ...raw, customType: "foreign" })?.role).toBe(
		"meta",
	);
	expect(
		projectNativeEntry({
			...raw,
			details: { jobId: "job-1", terminalRevision: -1 },
		})?.role,
	).toBe("meta");
});
