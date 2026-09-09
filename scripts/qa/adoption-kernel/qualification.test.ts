import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDigests } from "./candidate.ts";
import { qualify } from "./qualification.ts";
import { RunRegistry } from "./run-registry.ts";

test("qualification rejects absent history and missing host proofs", () => {
	const root = mkdtempSync(join(tmpdir(), "qualification-"));
	try {
		const registry = new RunRegistry(join(root, "registry.sqlite"));
		registry.close();
		const path = join(root, "index.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				registryPath: join(root, "registry.sqlite"),
				...candidateDigests(),
				frozenAt: "2000-01-01T00:00:00.000Z",
				hosts: [],
			}),
		);
		expect(() => qualify(path)).toThrow();
		writeFileSync(path, JSON.stringify({ version: 1, approved: true }));
		expect(() => qualify(path)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
