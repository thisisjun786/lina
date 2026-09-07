import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	createSessionContextPolicy,
	parseSessionContextMaterials,
	parseSessionContextPolicy,
} from "../src/context-policy.ts";

const old = {
	purpose: "conversation",
	version: 1,
	agentId: "mina",
	worldId: null,
	bindingRevision: 1,
	disclosureRevision: 2,
	sourcePolicyVersion: 1,
};
const author = {
	...old,
	purpose: "world-author",
	version: 2,
	worldId: "island",
	authorGrantId: "grant-1",
	capabilityPolicyDigest: "a".repeat(64),
};

test("v2 author policy binds the grant and native capability without changing v1 bytes", () => {
	for (const purpose of ["conversation", "life"]) {
		const fields = {
			...old,
			purpose,
			worldId: purpose === "life" ? "island" : null,
		};
		const policy = createSessionContextPolicy(fields);
		expect(JSON.stringify(policy)).toBe(
			JSON.stringify({
				...fields,
				scopeDigest: createHash("sha256")
					.update(JSON.stringify(fields))
					.digest("hex"),
			}),
		);
	}
	const policy = createSessionContextPolicy(author);
	expect(parseSessionContextPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(
		policy,
	);
	expect(policy.purpose).toBe("world-author");
	for (const patch of [
		{ authorGrantId: "grant-2" },
		{ capabilityPolicyDigest: "b".repeat(64) },
	]) {
		expect(
			createSessionContextPolicy({ ...author, ...patch }).scopeDigest,
		).not.toBe(policy.scopeDigest);
		expect(() => parseSessionContextPolicy({ ...policy, ...patch })).toThrow();
	}
});

test("author authority cannot enter an old policy or omit its native boundary", () => {
	for (const value of [
		{ ...old, authorGrantId: "grant-1" },
		{ ...old, version: 2 },
		{ ...author, version: 1 },
		{ ...author, purpose: "life" },
		{ ...author, worldId: null },
		{ ...author, authorGrantId: "" },
		{ ...author, capabilityPolicyDigest: "not-qualified" },
		{ ...author, extra: true },
	])
		expect(() => createSessionContextPolicy(value)).toThrow();
});

test("author material has its own strict codec", () => {
	expect(
		parseSessionContextMaterials([
			{ kind: "author-world", sourceId: "draft:1" },
		]),
	).toEqual([{ kind: "author-world", sourceId: "draft:1" }]);
	expect(() =>
		parseSessionContextMaterials([
			{ kind: "author-world", sourceId: "draft:1", authority: true },
		]),
	).toThrow();
});
