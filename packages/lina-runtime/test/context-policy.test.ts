import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	createSessionContextPolicy,
	parseSessionContextPolicy,
} from "../src/context-policy.ts";

const fields = {
	purpose: "conversation" as const,
	version: 1 as const,
	agentId: "mina",
	worldId: null,
	bindingRevision: 1,
	disclosureRevision: 2,
	sourcePolicyVersion: 1,
};
test("context policy rejects unknown authority, future versions and forged digests", () => {
	const policy = createSessionContextPolicy(fields);
	for (const patch of [
		{ scopeDigest: "a".repeat(64) },
		{ extra: true },
		{ purpose: "admin" },
		{ version: 2 },
		{ bindingRevision: -1 },
		{ disclosureRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ sourcePolicyVersion: 0 },
		{ agentId: "" },
		{ worldId: 4 },
	]) {
		expect(() => parseSessionContextPolicy({ ...policy, ...patch })).toThrow(
			/context policy/i,
		);
	}
	expect(() =>
		createSessionContextPolicy({ ...fields, scopeDigest: "forged" }),
	).toThrow();
});
test("canonical policy digest is ordered, validated and scope sensitive", () => {
	const policy = createSessionContextPolicy(fields);
	expect(policy.scopeDigest).toBe(
		createHash("sha256").update(JSON.stringify(fields)).digest("hex"),
	);
	expect(
		createSessionContextPolicy(
			Object.fromEntries(Object.entries(fields).reverse()),
		),
	).toEqual(policy);
	expect(parseSessionContextPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(
		policy,
	);
	for (const patch of [
		{ agentId: "rumi" },
		{ worldId: "world-b" },
		{ bindingRevision: 2 },
		{ disclosureRevision: 3 },
		{ sourcePolicyVersion: 2 },
		{ purpose: "life", worldId: "world-a" },
	]) {
		expect(
			createSessionContextPolicy({ ...fields, ...patch }).scopeDigest,
		).not.toBe(policy.scopeDigest);
	}
	expect(() =>
		createSessionContextPolicy({ ...fields, purpose: "life" }),
	).toThrow();
});
