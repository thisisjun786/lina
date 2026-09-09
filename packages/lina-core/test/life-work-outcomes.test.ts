import { expect, test } from "bun:test";
import {
	parseWorkConfig,
	parseWorkReceiptProvenance,
} from "../src/world/work-validation.ts";
import { workInput } from "./life-work-fixture.ts";

test("resource recorded outcome is a rule filter without widening task receipts", () => {
	const rule = {
		id: "recorded",
		familyId: "research",
		categoryId: "research",
		outcomes: ["recorded"],
		attribution: "owner",
		weight: 1,
		requiredMatch: false,
	};
	expect(parseWorkConfig({ rules: [rule] })).toMatchObject({ rules: [rule] });
	const source = workInput("world").source;
	expect(() =>
		parseWorkReceiptProvenance({ ...source.receipt, outcome: "recorded" }),
	).toThrow();
	expect(parseWorkReceiptProvenance(source.receipt)).toEqual(source.receipt);
});
