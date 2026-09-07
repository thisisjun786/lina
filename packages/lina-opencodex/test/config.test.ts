import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpenCodexConfig } from "../src/config.ts";

const secret = "ocx_admin_do_not_use_9f3a";
const providerKey = "sk-provider-secret-aaaa";

function home(config: unknown, extra?: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "lina-ocx-"));
	mkdirSync(join(dir, ".opencodex"), { recursive: true });
	writeFileSync(join(dir, ".opencodex", "config.json"), JSON.stringify(config));
	writeFileSync(join(dir, ".opencodex", "admin-api-token"), secret);
	if (extra) {
		for (const [name, body] of Object.entries(extra))
			writeFileSync(join(dir, ".opencodex", name), body);
	}
	return dir;
}

test("loopback listener supplies data origin without copying provider or admin secrets", () => {
	const dir = home({
		port: 10103,
		hostname: "100.64.0.1",
		hub: { managementPublicOrigin: "https://hub.example.ts.net:10100" },
		unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
		providers: { openai: { apiKey: providerKey } },
	});
	const cfg = discoverOpenCodexConfig({ env: {}, homeDir: dir });
	expect(cfg.origin).toBe("http://127.0.0.1:10100");
	expect(cfg.guiUrl).toBe("https://hub.example.ts.net:10100");
	expect(cfg.tokenRequired).toBe(false);
	expect(cfg.admissionToken).toBeNull();
	expect(cfg.loopback).toBe(true);
	expect(JSON.stringify(cfg)).not.toContain(secret);
	expect(JSON.stringify(cfg)).not.toContain(providerKey);
});

test("remote hub without an explicit data token is not configured and never reads the admin file", () => {
	const dir = home({
		hub: { managementPublicOrigin: "https://hub.example.ts.net:10100" },
	});
	const cfg = discoverOpenCodexConfig({
		env: { LINA_OPENCODEX_BASE_URL: "https://hub.example.ts.net:10100" },
		homeDir: dir,
	});
	expect(cfg.configured).toBe(false);
	expect(cfg.tokenRequired).toBe(true);
	expect(cfg.admissionToken).toBeNull();
	expect(cfg.error).toMatch(/LINA_OPENCODEX_API_KEY|TOKEN_FILE/);
});

test("env base URL, GUI URL, and token file override discovered values", () => {
	const dir = home(
		{
			unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
			hub: { managementPublicOrigin: "https://old.example:1" },
		},
		{ "data-key": "ocx_data_token_bbbb\n" },
	);
	const cfg = discoverOpenCodexConfig({
		env: {
			LINA_OPENCODEX_BASE_URL: "https://hub.example.ts.net:10100/v1",
			LINA_OPENCODEX_GUI_URL: "https://gui.example.ts.net:8443",
			LINA_OPENCODEX_TOKEN_FILE: join(dir, ".opencodex", "data-key"),
		},
		homeDir: dir,
	});
	expect(cfg.origin).toBe("https://hub.example.ts.net:10100");
	expect(cfg.guiUrl).toBe("https://gui.example.ts.net:8443");
	expect(cfg.admissionToken).toBe("ocx_data_token_bbbb");
	expect(cfg.tokenRequired).toBe(true);
	expect(cfg.configured).toBe(true);
});

test("API key env wins over token file and GUI is not used as the data origin", () => {
	const dir = home({
		hub: { managementPublicOrigin: "https://gui.example.ts.net:10100" },
	});
	const cfg = discoverOpenCodexConfig({
		env: {
			LINA_OPENCODEX_API_KEY: "ocx_data_token_cccc",
			LINA_OPENCODEX_TOKEN_FILE: join(dir, ".opencodex", "admin-api-token"),
		},
		homeDir: dir,
	});
	expect(cfg.configured).toBe(false);
	expect(cfg.guiUrl).toBe("https://gui.example.ts.net:10100");
	expect(cfg.origin).toBeNull();
	expect(cfg.admissionToken).toBe("ocx_data_token_cccc");
});
