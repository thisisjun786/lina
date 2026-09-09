import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installRelease } from "../src/install-release.ts";

const ensemblePath = "packages/lina-runtime/vendor/ensemble";

function releaseFixture(root: string) {
	const source = join(root, "source");
	const files: Record<string, string> = {
		"package.json": "{}",
		"bun.lock": "{}",
		LICENSE: "fixture root license\n",
		NOTICE: "fixture root notice\n",
		"THIRD_PARTY_NOTICES.md": "fixture third-party notices\n",
		"packages/lina-runtime/package.json": "{}",
		"packages/lina-runtime/scripts/lina.ts": 'console.log("fixture");',
		[`${ensemblePath}/LICENSE.md`]: "fixture UC BSD-4 license\n",
		[`${ensemblePath}/manifest.json`]: JSON.stringify({
			revision: "8b74bdec4ba2ef4e14795b7591df3b5d73f283e3",
			license: { file: "LICENSE.md" },
		}),
		[`${ensemblePath}/underscore.ts`]:
			"// independently authored fixture helper\n",
	};
	for (const name of [
		"util",
		"socialRecord",
		"ruleLibrary",
		"actionLibrary",
		"volition",
		"validate",
		"ensemble",
	])
		files[`${ensemblePath}/upstream/${name}.js.txt`] = `// fixture ${name}\n`;
	for (const [relative, content] of Object.entries(files)) {
		mkdirSync(dirname(join(source, relative)), { recursive: true });
		writeFileSync(join(source, relative), content);
	}
	return { source, home: join(root, "home"), files };
}

test("release installs only the reviewed Ensemble vendor subtree and hashes its contents", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-release-ensemble-"));
	try {
		const { source, home, files } = releaseFixture(root);
		const excluded = [
			"packages/lina-runtime/test/private.sqlite",
			"packages/lina-runtime/vendor/unreviewed/private.sqlite",
			"packages/lina-core/vendor/ensemble/private.sqlite",
			`${ensemblePath}/.env.local`,
			`${ensemblePath}/debug.log`,
			`${ensemblePath}/.git/config`,
			`${ensemblePath}/node_modules/private.sqlite`,
			`${ensemblePath}/dist/private.sqlite`,
		];
		for (const relative of excluded) {
			mkdirSync(dirname(join(source, relative)), { recursive: true });
			writeFileSync(join(source, relative), "private fixture");
		}
		writeFileSync(join(source, "packages/lina-core/package.json"), "{}");
		const first = await installRelease({
			source,
			home,
			prepare: async () => {},
		});
		for (const [relative, content] of Object.entries(files))
			expect(readFileSync(join(first.path, relative), "utf8")).toBe(content);
		for (const relative of excluded)
			expect(existsSync(join(first.path, relative))).toBe(false);
		const module = `${ensemblePath}/upstream/ensemble.js.txt`;
		writeFileSync(join(source, module), "// changed fixture module\n");
		const second = await installRelease({
			source,
			home,
			prepare: async () => {},
		});
		expect(second.release).not.toBe(first.release);
		expect(readFileSync(join(second.path, module), "utf8")).toBe(
			"// changed fixture module\n",
		);
		expect(readFileSync(join(first.path, module), "utf8")).toBe(
			"// fixture ensemble\n",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	"packages/lina-runtime/vendor",
	ensemblePath,
	`${ensemblePath}/upstream/util.js.txt`,
])("release rejects symlinked Ensemble assets at %s", async (relative) => {
	const root = mkdtempSync(join(tmpdir(), "lina-release-ensemble-link-"));
	try {
		const { source, home } = releaseFixture(root);
		rmSync(join(source, relative), { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(join(outside, "ensemble"), { recursive: true });
		writeFileSync(join(outside, "ensemble/private.txt"), "private fixture");
		symlinkSync(outside, join(source, relative));
		await expect(
			installRelease({ source, home, prepare: async () => {} }),
		).rejects.toThrow();
		expect(existsSync(join(home, "runtime/current.json"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["private.sqlite", "binding.json", "task-runtime.json"])(
	"release rejects runtime state inside Ensemble vendor: %s",
	async (name) => {
		const root = mkdtempSync(join(tmpdir(), "lina-release-ensemble-state-"));
		try {
			const { source, home } = releaseFixture(root);
			writeFileSync(join(source, ensemblePath, name), "private fixture");
			await expect(
				installRelease({ source, home, prepare: async () => {} }),
			).rejects.toThrow("Runtime state found");
			expect(existsSync(join(home, "runtime/current.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("release installation rejects destinations inside the source tree", async () => {
	const source = mkdtempSync(join(tmpdir(), "lina-release-overlap-"));
	try {
		await expect(
			installRelease({
				source,
				home: join(source, "packages/home"),
				prepare: async () => {},
			}),
		).rejects.toThrow("outside the source tree");
	} finally {
		rmSync(source, { recursive: true, force: true });
	}
});

test("release installation preserves state and switches only after dependency preparation", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-release-"));
	try {
		const source = join(root, "source"),
			home = join(root, "home");
		mkdirSync(join(source, "packages/lina-runtime/scripts"), {
			recursive: true,
		});
		mkdirSync(join(source, "data"));
		writeFileSync(join(source, "package.json"), "{}");
		writeFileSync(join(source, "packages/lina-runtime/package.json"), "{}");
		writeFileSync(join(source, "bun.lock"), "{}");
		for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"])
			writeFileSync(join(source, name), `fixture ${name}\n`);
		mkdirSync(join(source, "packages/lina-runtime/test"));
		writeFileSync(
			join(source, "packages/lina-runtime/test/private.sqlite"),
			"private",
		);
		writeFileSync(
			join(source, "packages/lina-runtime/scripts/lina.ts"),
			'console.log("fixture")',
		);
		mkdirSync(join(home, "state"), { recursive: true });
		writeFileSync(join(home, "state/memory.json"), '"keep"');
		const first = await installRelease({
			source,
			home,
			prepare: async () => {},
		});
		for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
			expect(readFileSync(join(first.path, name), "utf8")).toBe(
				readFileSync(join(source, name), "utf8"),
			);
		}
		const pointer = readFileSync(join(home, "runtime/current.json"), "utf8");
		rmSync(join(source, "NOTICE"));
		await expect(
			installRelease({ source, home, prepare: async () => {} }),
		).rejects.toThrow("NOTICE");
		expect(readFileSync(join(home, "runtime/current.json"), "utf8")).toBe(
			pointer,
		);
		writeFileSync(join(source, "NOTICE"), "fixture NOTICE\n");
		writeFileSync(
			join(source, "packages/lina-runtime/scripts/lina.ts"),
			'console.log("changed")',
		);
		await expect(
			installRelease({
				source,
				home,
				prepare: async () => {
					throw Error("dependency failure");
				},
			}),
		).rejects.toThrow("dependency failure");
		expect(readFileSync(join(home, "runtime/current.json"), "utf8")).toBe(
			pointer,
		);
		expect(readFileSync(join(home, "state/memory.json"), "utf8")).toBe(
			'"keep"',
		);
		expect(first.release).toMatch(/^[a-f0-9]{64}$/);
		expect(
			existsSync(join(first.path, "packages/lina-runtime/test/private.sqlite")),
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
