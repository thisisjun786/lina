import { describe, expect, it } from "bun:test";
import { resolveProfile } from "../src/models/selection.ts";
import type {
	ModelProfile,
	ModelRole,
	ModelSettings,
} from "../src/models/types.ts";

function profile(id: string): ModelProfile {
	return {
		id,
		provider: "synthetic",
		model: `model-${id}`,
		reasoning: "low",
		maxOutputTokens: 1024,
	};
}

function settings(): ModelSettings {
	return {
		revision: 7,
		profiles: ["override", "agent", "global", "default", "other-agent"].map(
			profile,
		),
		defaultProfileId: "default",
		roles: { conversation: "global" },
		agentRoles: {
			lina: { conversation: "agent" },
			rumi: { conversation: "other-agent" },
		},
	};
}

describe("model profile selection", () => {
	it("explicit isolated override wins over agent, global role and default", () => {
		expect(
			resolveProfile(settings(), "conversation", "lina", "override"),
		).toEqual(profile("override"));
	});
	it("agent role wins over global role and default with agent isolation", () => {
		expect(resolveProfile(settings(), "conversation", "lina")).toEqual(
			profile("agent"),
		);
		expect(resolveProfile(settings(), "conversation", "rumi")).toEqual(
			profile("other-agent"),
		);
	});
	it("global role wins over default when agent or its role is absent", () => {
		const value = settings();
		value.agentRoles["empty-agent"] = { recall: "agent" };
		for (const id of [
			undefined,
			"unknown-agent",
			"empty-agent",
			"constructor",
			"tostring",
		])
			expect(resolveProfile(value, "conversation", id)).toEqual(
				profile("global"),
			);
	});
	it("default wins when neither agent nor global role is bound", () => {
		expect(resolveProfile(settings(), "summary", "lina")).toEqual(
			profile("default"),
		);
	});
	it.each<ModelRole>([
		"conversation",
		"summary",
		"observation",
		"reflection",
		"recall",
	])("resolves %s and returns null for host native defaults", (role) => {
		const value = settings();
		value.roles = {};
		value.agentRoles = {};
		value.defaultProfileId = null;
		expect(resolveProfile(value, role)).toBeNull();
		value.roles[role] = "global";
		expect(resolveProfile(value, role)).toEqual(profile("global"));
		value.agentRoles["lina"] = { [role]: "agent" };
		expect(resolveProfile(value, role, "lina")).toEqual(profile("agent"));
	});
	it("rejects unknown explicit overrides rather than silently using a different model", () => {
		expect(() =>
			resolveProfile(settings(), "conversation", "lina", "missing"),
		).toThrow(/profile/i);
	});
	it("does not mutate a frozen settings snapshot and detaches the selected profile", () => {
		const value = settings();
		const before = structuredClone(value);
		for (const item of value.profiles) Object.freeze(item);
		Object.freeze(value.profiles);
		Object.freeze(value.roles);
		for (const roles of Object.values(value.agentRoles)) Object.freeze(roles);
		Object.freeze(value.agentRoles);
		Object.freeze(value);
		const selected = resolveProfile(value, "conversation", "lina");
		expect(selected).toEqual(profile("agent"));
		if (!selected) throw new Error("expected selected profile");
		selected.model = "mutated";
		expect(value).toEqual(before);
	});
});
