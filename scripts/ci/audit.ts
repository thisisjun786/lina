import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

type Inventory = Record<string, string[]>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Bun's lock audit misses packages embedded inside published tarballs. */
export function installedInventory(root: string): Inventory {
	const checkout = realpathSync(root);
	const visited = new Set<string>();
	const versions = new Map<string, Set<string>>();
	const visit = (
		path: string,
		kind: "modules" | "scope" | "store" | "package",
	) => {
		const actual = realpathSync(path);
		assert(
			actual.startsWith(checkout + sep),
			"Dependency link escapes checkout",
		);
		if (visited.has(actual)) return;
		visited.add(actual);
		if (kind === "package") {
			const metadata = JSON.parse(
				readFileSync(join(actual, "package.json"), "utf8"),
			);
			assert(
				typeof metadata.name === "string" &&
					typeof metadata.version === "string",
				"Invalid installed package metadata",
			);
			// Workspace sources are not registry packages; still inspect their dependencies.
			if (actual.includes(`${sep}node_modules${sep}`)) {
				const values = versions.get(metadata.name) ?? new Set<string>();
				values.add(metadata.version);
				versions.set(metadata.name, values);
			}
			if (existsSync(join(actual, "node_modules")))
				visit(join(actual, "node_modules"), "modules");
			return;
		}
		for (const entry of readdirSync(actual, { withFileTypes: true })) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const child = join(actual, entry.name);
			if (kind === "store") {
				if (existsSync(join(child, "node_modules")))
					visit(join(child, "node_modules"), "modules");
			} else if (entry.name === ".bun") visit(child, "store");
			else if (!entry.name.startsWith("."))
				visit(child, entry.name.startsWith("@") ? "scope" : "package");
		}
	};
	visit(join(checkout, "node_modules"), "modules");
	const packages = join(checkout, "packages");
	if (existsSync(packages)) {
		for (const entry of readdirSync(packages)) {
			const modules = join(packages, entry, "node_modules");
			if (existsSync(modules)) visit(modules, "modules");
		}
	}
	assert(versions.size > 0, "Installed dependency inventory is empty");
	return Object.fromEntries(
		[...versions].sort().map(([name, values]) => [name, [...values].sort()]),
	);
}

export async function auditInstalled(
	inventory: Inventory,
	request: Fetcher = fetch,
) {
	assert(
		Object.keys(inventory).length > 0,
		"Installed dependency inventory is empty",
	);
	const response = await request(
		"https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(inventory),
			signal: AbortSignal.timeout(30_000),
		},
	);
	assert(response.ok, `Installed dependency audit HTTP ${response.status}`);
	const findings: unknown = await response.json();
	assert(
		findings !== null &&
			typeof findings === "object" &&
			!Array.isArray(findings),
		"Invalid advisory response",
	);
	const affected: string[] = [];
	for (const [name, advisories] of Object.entries(findings)) {
		assert(
			Object.hasOwn(inventory, name) && Array.isArray(advisories),
			"Invalid advisory response entry",
		);
		if (advisories.length)
			affected.push(`${name}: ${advisories.length} advisories`);
	}
	assert(
		affected.length === 0,
		`Vulnerable installed dependencies: ${affected.join(", ")}`,
	);
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "../..");
	const lockAudit = Bun.spawn([process.execPath, "audit"], {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	assert((await lockAudit.exited) === 0, "Lockfile dependency audit failed");
	const inventory = installedInventory(root);
	await auditInstalled(inventory);
	console.log(
		`Installed dependency audit passed: ${Object.keys(inventory).length} package names, including bundled copies.`,
	);
}
