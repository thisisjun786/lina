import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditInstalled, installedInventory } from "./audit.ts";

test("installed inventory includes vulnerable bundled copies despite a safe lock and symlink aliases", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-audit-"));
	const pkg = (path: string, name: string, version: string) => {
		mkdirSync(join(root, path), { recursive: true });
		writeFileSync(
			join(root, path, "package.json"),
			JSON.stringify({ name, version }),
		);
	};
	try {
		writeFileSync(join(root, "bun.lock"), '{"packages":{"qs":["qs@6.16.0"]}}');
		pkg("node_modules/.bun/engine@1/node_modules/engine", "engine", "1.0.0");
		pkg(
			"node_modules/.bun/engine@1/node_modules/engine/node_modules/qs",
			"qs",
			"6.15.3",
		);
		pkg("node_modules/qs", "qs", "6.16.0");
		symlinkSync(
			".bun/engine@1/node_modules/engine",
			join(root, "node_modules/engine"),
		);
		const inventory = installedInventory(root);
		expect(inventory["qs"]).toEqual(["6.15.3", "6.16.0"]);
		expect(inventory["engine"]).toEqual(["1.0.0"]);
		await expect(
			auditInstalled(inventory, async (_url, init) => {
				expect(JSON.parse(String(init?.body))["qs"]).toContain("6.15.3");
				return Response.json({
					qs: [
						{
							id: 1,
							title: "fixture advisory",
							vulnerable_versions: "<6.16.0",
						},
					],
				});
			}),
		).rejects.toThrow("qs");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit fails closed on unreadable inventory, empty installs, network and malformed responses", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-audit-errors-"));
	try {
		expect(() => installedInventory(root)).toThrow();
		mkdirSync(join(root, "node_modules"));
		expect(() => installedInventory(root)).toThrow("empty");
		mkdirSync(join(root, "node_modules/broken"));
		writeFileSync(join(root, "node_modules/broken/package.json"), "{");
		expect(() => installedInventory(root)).toThrow();
		for (const response of [
			new Response("offline", { status: 503 }),
			Response.json(null),
			Response.json([]),
			Response.json({ qs: {} }),
			new Response("{"),
		]) {
			await expect(
				auditInstalled({ qs: ["6.16.0"] }, async () => response),
			).rejects.toThrow();
		}
		await expect(
			auditInstalled({ qs: ["6.16.0"] }, async () => {
				throw Error("offline");
			}),
		).rejects.toThrow("offline");
		await expect(
			auditInstalled({ qs: ["6.16.0"] }, async () => Response.json({})),
		).resolves.toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
