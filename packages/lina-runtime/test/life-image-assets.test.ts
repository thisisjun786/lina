import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LifeImageAssets,
	lifeImageOwnerRoot,
} from "../src/images/life-assets.ts";
import { png } from "./ima2-client-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function root() {
	const r = mkdtempSync(join(tmpdir(), "lina-life-image-assets-"));
	roots.push(r);
	return r;
}
const owner = { kind: "life" as const, worldId: "world", agentId: "lina" };
function port() {
	return { beforeWrite: () => undefined, retained: () => undefined };
}

test("LIFE file import adopts the same UUID bytes on reopen and never assigns UUID as avatar hash", () => {
	const directory = root(),
		id = randomUUID();
	let retained = 0;
	const assets = new LifeImageAssets(directory, owner, {
		...port(),
		retained: () => {
			retained++;
		},
	});
	const metadata = assets.importOutput(id, { bytes: png, mime: "image/png" });
	expect(metadata.id).toBe(id);
	expect(metadata.sha256).not.toBe(id);
	expect(assets.bytes(metadata)).toEqual(new Uint8Array(png));
	const read = new LifeImageAssets(directory, owner);
	expect(read.bytes(metadata)).toEqual(new Uint8Array(png));
	expect(() =>
		read.importOutput(id, { bytes: png, mime: "image/png" }),
	).toThrow(/read-only/);
	expect(
		new LifeImageAssets(directory, owner, port()).importOutput(id, {
			bytes: png,
			mime: "image/png",
		}),
	).toEqual(metadata);
	expect(retained).toBe(1);
	expect(
		readdirSync(join(lifeImageOwnerRoot(directory, owner, false), "assets")),
	).toEqual([id]);
});

test("capacity denial creates no file and committed-byte callback failure leaves a recoverable orphan", () => {
	const directory = root(),
		id = randomUUID();
	const denied = new LifeImageAssets(directory, owner, {
		...port(),
		beforeWrite: () => {
			throw Error("capacity");
		},
	});
	expect(() =>
		denied.importOutput(id, { bytes: png, mime: "image/png" }),
	).toThrow("capacity");
	expect(
		readdirSync(join(lifeImageOwnerRoot(directory, owner, false), "assets")),
	).toEqual([]);
	const interrupted = new LifeImageAssets(directory, owner, {
		...port(),
		retained: () => {
			throw Error("lost metadata receipt");
		},
	});
	expect(() =>
		interrupted.importOutput(id, { bytes: png, mime: "image/png" }),
	).toThrow("lost metadata receipt");
	let existed: boolean | undefined;
	const repaired = new LifeImageAssets(directory, owner, {
		...port(),
		beforeWrite: (_metadata, existing) => {
			existed = existing;
		},
	});
	const metadata = repaired.importOutput(id, { bytes: png, mime: "image/png" });
	expect(existed).toBe(true);
	expect(repaired.bytes(metadata)).toEqual(new Uint8Array(png));
});

test("foreign roots, unsafe IDs and symlinked files cannot be read as LIFE artifacts", () => {
	const directory = root(),
		id = randomUUID();
	const assets = new LifeImageAssets(directory, owner, port());
	const metadata = assets.importOutput(id, { bytes: png, mime: "image/png" });
	expect(
		() => new LifeImageAssets(directory, { ...owner, agentId: "mira" }),
	).toThrow();
	expect(() => assets.bytes({ ...metadata, id: "../../secret" })).toThrow();
	const path = join(lifeImageOwnerRoot(directory, owner, false), "assets", id);
	rmSync(path);
	symlinkSync(join(directory, "secret"), path);
	writeFileSync(join(directory, "secret"), png);
	expect(() => assets.bytes(metadata)).toThrow();
	expect(() =>
		assets.importOutput(id, { bytes: png, mime: "image/png" }),
	).toThrow();
});

test("cold read never initializes storage and changed retained bytes fail integrity", () => {
	const directory = root();
	expect(() => new LifeImageAssets(directory, owner)).toThrow();
	expect(existsSync(join(directory, "life"))).toBe(false);
	const id = randomUUID(),
		assets = new LifeImageAssets(directory, owner, port());
	const metadata = assets.importOutput(id, { bytes: png, mime: "image/png" });
	const path = join(lifeImageOwnerRoot(directory, owner, false), "assets", id);
	const changed = new Uint8Array(readFileSync(path));
	changed[changed.length - 1] = 0;
	writeFileSync(path, changed);
	expect(() => assets.bytes(metadata)).toThrow();
	expect(() =>
		assets.importOutput(id, { bytes: png, mime: "image/png" }),
	).toThrow(/conflict/);
});

test("invalid media never reaches capacity accounting or disk", () => {
	const directory = root();
	let called = false;
	const assets = new LifeImageAssets(directory, owner, {
		...port(),
		beforeWrite: () => {
			called = true;
		},
	});
	expect(() =>
		assets.importOutput(randomUUID(), {
			bytes: new TextEncoder().encode("private text"),
			mime: "image/png",
		}),
	).toThrow();
	expect(called).toBe(false);
});
