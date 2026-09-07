import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

test("web assets build the shared renderer and portable client owns wire parsing", async () => {
	const ui = new URL("../../lina-ui/client/app.ts", import.meta.url);
	expect(existsSync(ui)).toBe(true);
	const protocol = await import("../../lina-client/src/protocol.ts");
	expect(
		protocol.parseServerFrame('{"type":"agent-status","state":"idle"}'),
	).toEqual({ type: "agent-status", state: "idle" });
	expect(
		readFileSync(new URL("../src/assets.ts", import.meta.url), "utf8"),
	).toContain("../../lina-ui/client/");
});
