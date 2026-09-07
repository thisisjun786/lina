import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../src/session-binding.ts";
import { Fixture } from "./fixture.ts";

it.each(["before-binding", "after-binding"])(
	"releases both lifetime leases after SIGKILL %s without deleting lease files",
	async (stage) => {
		const fixture = new Fixture();
		const { root, binding } = fixture;
		const child = Bun.spawn(
			[
				process.execPath,
				fileURLToPath(new URL("./lease-child.ts", import.meta.url)),
				root,
				binding.workspace,
				binding.sessionFile,
				stage,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		try {
			const ready = await child.stdout.getReader().read();
			expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
			expect(() =>
				acquireSessionLease(root, "lina", binding.workspace),
			).toThrow();
			expect(() =>
				acquireTranscriptLease(binding.sessionFile, "lina", binding.workspace),
			).toThrow();
			child.kill("SIGKILL");
			await child.exited;
			const reopened = fixture.keep(
				acquireSessionLease(root, "lina", binding.workspace),
			);
			expect(reopened.readBinding()).toEqual(
				stage === "after-binding" ? binding : undefined,
			);
			fixture.keep(
				acquireTranscriptLease(binding.sessionFile, "lina", binding.workspace),
			);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
			fixture.close();
		}
	},
);
