import { expect, test } from "bun:test";
import { parseLifeModelRequest } from "../../lina-core/src/world/autonomy-record-validation.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { lifePlan } from "../src/life-model-policy.ts";
import { lifeFixture, lifeRequest } from "./life-model-fixture.ts";

test("versioned LIFE requests validate frozen routes and preserve historical request JSON", () => {
	const old = lifeRequest();
	expect(parseLifeModelRequest(old)).toEqual(old);
	const { stepId: _step, ...base } = old;
	const publication = {
		...base,
		version: 2,
		lane: "publication",
		jobId: "job",
	};
	expect(parseLifeModelRequest(publication)).toMatchObject(publication);
	const fields = {
		profileId: "life",
		provider: old.provider,
		model: old.model,
		reasoning: "off",
		maxOutputTokens: 1024,
		settingsRevision: 7,
	};
	const selection = { ...fields, routeFingerprint: lifeDigest(fields) };
	for (const request of [old, publication]) {
		const next = { ...request, version: 3, selection };
		expect(parseLifeModelRequest(next)).toMatchObject(next);
		expect(() => parseLifeModelRequest({ ...next, model: "other" })).toThrow(
			"differs",
		);
		expect(() =>
			parseLifeModelRequest({
				...next,
				limits: { ...old.limits, maxOutputTokens: 2048 },
			}),
		).toThrow("differs");
	}
});
test("native LIFE preparation rejects effort/profile drift against the frozen route", async () => {
	const f = lifeFixture();
	const old = lifeRequest();
	const fields = {
		profileId: "life",
		provider: old.provider,
		model: old.model,
		reasoning: "off",
		maxOutputTokens: null,
		settingsRevision: 7,
	};
	const request = parseLifeModelRequest({
		...old,
		version: 3,
		selection: { ...fields, routeFingerprint: lifeDigest(fields) },
	});
	const options = {
		...f.options,
		command: process.execPath,
		wrapperCommand: process.execPath,
	};
	try {
		expect(lifePlan(options, request).selection.selected.id).toBe("life");
		for (const override of [
			{ reasoning: "low" as const },
			{ maxOutputTokens: 2048 },
		]) {
			const changed = {
				...options,
				selection: () => ({
					...f.selection,
					selected: { ...f.selection.selected, ...override },
				}),
			};
			expect(() => lifePlan(changed, request)).toThrow("frozen selection");
		}
		f.selection.selected.id = "other";
		expect(() => lifePlan(options, request)).toThrow("frozen selection");
		expect(f.captures).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("new and historical LIFE journals reopen without rewriting saved requests", async () => {
	const { LifeModelJournal } = await import("../src/life-model-journal.ts");
	const { lifeReference } = await import("../src/life-model-validation.ts");
	const { readFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const f = lifeFixture();
	try {
		for (const version of [1, 3] as const) {
			const old = lifeRequest();
			const fields = {
				profileId: "life",
				provider: old.provider,
				model: old.model,
				reasoning: "off",
				maxOutputTokens: null,
				settingsRevision: 7,
			};
			const request = parseLifeModelRequest(
				version === 1
					? old
					: {
							...old,
							version,
							selection: { ...fields, routeFingerprint: lifeDigest(fields) },
						},
			);
			const prepared = {
				version: 1 as const,
				request,
				inputDigest: lifeDigest(request),
				capabilityFingerprint: "a".repeat(64),
				nativeReference: lifeReference(request),
			};
			const first = new LifeModelJournal(f.root, prepared, true);
			const file = join(first.directory, "initial.json");
			const before = readFileSync(file);
			const reopened = new LifeModelJournal(f.root, prepared);
			expect(reopened.reconcile()).toMatchObject({ status: "not_dispatched" });
			expect(readFileSync(file)).toEqual(before);
		}
		expect(f.captures).toHaveLength(0);
	} finally {
		await f.close();
	}
});
