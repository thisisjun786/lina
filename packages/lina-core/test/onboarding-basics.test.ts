import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DialogueStore } from "../src/onboarding/dialogue-store.ts";
import { unspecifiedProfile } from "../src/onboarding/helpers.ts";
import { parseUserSkipped, userBasics } from "../src/onboarding/user-basics.ts";

test("legacy five-field dialogue data and new refusal evidence both survive reopening", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-basic-store-"));
	const path = join(root, "intro.sqlite");
	let store = new DialogueStore(path);
	const data = {
		profile: unspecifiedProfile("lina"),
		chapters: {
			identity: "",
			values: "",
			temperament: "",
			interests: "",
			relationship: "",
			expression: "",
		},
		user: { address: "유진" },
		summary: [],
		ready: false,
	};
	try {
		const old = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data,
		});
		const newer = store.create({
			agentId: "other",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: {
				...data,
				profile: unspecifiedProfile("other"),
				userSkipped: { communication: "말투는 나중에 정할게" },
			},
		});
		store.close();
		store = new DialogueStore(path);
		expect(store.get(old.id)?.data).toEqual(data);
		expect(store.get(newer.id)?.data.userSkipped).toEqual({
			communication: "말투는 나중에 정할게",
		});
		const reopened = store.get(newer.id);
		if (!reopened) throw Error("missing reopened room");
		expect(userBasics(reopened.data.user, reopened.data.userSkipped)).toEqual({
			missing: ["context", "interests"],
			completed: 2,
			total: 4,
		});
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
test("skipped basics validator rejects unknown keys, wrong types, blank and oversized evidence", () => {
	expect(parseUserSkipped(undefined)).toEqual({});
	for (const v of [
		null,
		[],
		{ name: "거부" },
		{ address: 1 },
		{ address: "" },
		{ address: "x".repeat(4001) },
	])
		expect(() => parseUserSkipped(v)).toThrow();
});
