import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createCodexLifeModel } from "../src/life-model.ts";
import {
	lifeFixture,
	lifeMetadata,
	lifeRequest,
} from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
function fixture() {
	const f = lifeFixture();
	clean.push(() => f.close());
	const port = createCodexLifeModel(f.options);
	clean.push(() => port.close());
	return { ...f, port };
}
const directory = (root: string, reference: string) =>
	join(root, "life-model", reference.slice("life-model-".length));

test("unavailable native executable fails closed without configured traffic", async () => {
	const f = fixture();
	const port = createCodexLifeModel({
		...f.options,
		wrapperCommand: "/missing/lina-life-bwrap",
	});
	clean.push(() => port.close());
	await expect(port.prepare(lifeRequest(), signal())).rejects.toThrow();
	expect(f.captures).toHaveLength(0);
});

nativeTest(
	"qualification proves OS path denial and exact empty skills inventory",
	async () => {
		const f = fixture();
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const base = directory(f.root, prepared.nativeReference);
		const q = readdirSync(base).find((name) =>
			name.startsWith("qualification-"),
		) as string;
		const receipt = JSON.parse(
			readFileSync(join(base, q, "receipt.json"), "utf8"),
		);
		expect(receipt).toMatchObject({
			configuredProviderCalls: 0,
			outsideReadDenied: true,
			outsideWriteDenied: true,
			ownedWriteAllowed: true,
			emptySkillsInventories: 4,
			separateThreads: 4,
		});
		expect(f.captures).toHaveLength(0);
	},
	60000,
);

nativeTest(
	"changed prepared request, changed selection and occupied native paths cannot dispatch",
	async () => {
		const f = fixture();
		const request = lifeRequest();
		const prepared = await f.port.prepare(request, signal());
		await expect(
			f.port.complete(
				{ ...prepared, request: { ...request, input: "foreign" } },
				signal(),
			),
		).rejects.toThrow();
		await expect(
			f.port.prepare({ ...request, input: "changed" }, signal()),
		).rejects.toThrow();
		f.selection.settingsRevision++;
		await expect(f.port.complete(prepared, signal())).rejects.toThrow();
		f.selection.settingsRevision--;
		const outside = join(f.root, "outside.txt");
		writeFileSync(outside, "OUTSIDE");
		symlinkSync(
			f.root,
			join(directory(f.root, prepared.nativeReference), "native"),
		);
		await expect(f.port.complete(prepared, signal())).rejects.toThrow();
		expect(readFileSync(outside, "utf8")).toBe("OUTSIDE");
		expect(existsSync(join(f.root, "home"))).toBe(false);
		expect(f.captures).toHaveLength(0);
	},
	60000,
);

nativeTest(
	"prepared request survives close/reopen and concurrent completion reaches provider once",
	async () => {
		const f = fixture();
		const prepared = await f.port.prepare(lifeRequest(), signal());
		await f.port.close();
		const one = createCodexLifeModel(f.options),
			two = createCodexLifeModel(f.options);
		clean.push(
			() => one.close(),
			() => two.close(),
		);
		expect(await one.reconcile(prepared)).toEqual({ status: "not_dispatched" });
		const results = await Promise.allSettled([
			one.complete(prepared, signal()),
			two.complete(prepared, signal()),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);

test("close racing an unopened prepare cancels it without allocating a child", async () => {
	const f = fixture();
	const pending = f.port.prepare(lifeRequest(), signal());
	void pending.catch(() => undefined);
	await f.port.close();
	await expect(pending).rejects.toThrow();
	await expect(f.port.prepare(lifeRequest(), signal())).rejects.toThrow(
		/closed/,
	);
	expect(f.captures).toHaveLength(0);
});

nativeTest(
	"slash-routed model identity is preserved through qualification and the actual POST",
	async () => {
		const f = fixture();
		f.selection.selected.model = "synthetic/namespace/life";
		f.selection.connection.catalogJson = JSON.stringify({
			models: [{ ...lifeMetadata, slug: f.selection.selected.model }],
		});
		const prepared = await f.port.prepare(
			lifeRequest({ model: f.selection.selected.model }),
			signal(),
		);
		const result = await f.port.complete(prepared, signal());
		expect(result.model).toBe("synthetic/namespace/life");
		expect(f.captures[0]?.body["model"]).toBe("synthetic/namespace/life");
	},
	60000,
);
