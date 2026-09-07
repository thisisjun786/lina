import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("CLI paths works outside checkout without opening providers or writing a home", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-cli-"));
	try {
		const home = join(root, "new home");
		const env: NodeJS.ProcessEnv = { ...process.env, LINA_HOME: home };
		delete env["LINA_STATE_DIR"];
		const result = Bun.spawnSync(
			[
				process.execPath,
				resolve(import.meta.dir, "../scripts/lina.ts"),
				"paths",
			],
			{ cwd: root, env },
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString()).home).toBe(home);
		expect(existsSync(home)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
