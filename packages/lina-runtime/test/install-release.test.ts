import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRelease } from "../src/install-release.ts";

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
