import { expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionCodexHome } from "../src/fleet/codex-home.ts";

test("assistant home contains only Hub routing/catalog and leaves shared config untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-home-"));
	try {
		const home = provisionCodexHome(root, {
			providerTable:
				'[model_providers.opencodex]\nbase_url = "http://127.0.0.1:10100/v1"\nrequires_openai_auth = false\n',
			catalogJson: '{"models":[]}',
		});
		const text = readFileSync(join(home, "config.toml"), "utf8");
		expect(text).toContain('model_provider = "opencodex"');
		expect(text).toContain("requires_openai_auth = false");
		expect(text).not.toMatch(/token =|api_key =|hooks/);
		expect(readFileSync(join(home, "opencodex-catalog.json"), "utf8")).toBe(
			'{"models":[]}',
		);
		const foreign = join(root, "foreign");
		writeFileSync(foreign, "keep");
		rmSync(join(home, "config.toml"));
		symlinkSync(foreign, join(home, "config.toml"));
		expect(() =>
			provisionCodexHome(root, { providerTable: "bad", catalogJson: null }),
		).toThrow();
		expect(readFileSync(foreign, "utf8")).toBe("keep");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
