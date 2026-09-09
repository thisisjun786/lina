import { createHash, randomUUID } from "node:crypto";
import type { PublicCase, PublicStage, ToolSpec } from "./harness-types.ts";
import { BEHAVIOR_IDS, type PrivateTruth } from "./truth.ts";
import type { Evidence, Purpose } from "./types.ts";

const catalog: ToolSpec[] = [
	{
		name: "lookup",
		description: "Read a value by key. Returns key/value or failure.",
		arguments: { key: "string" },
	},
	{
		name: "calculate",
		description: "Integer arithmetic.",
		arguments: {
			op: "add|subtract|multiply",
			left: "integer",
			right: "integer",
		},
	},
	{
		name: "submit",
		description: "Submit items for a task, optionally using a named method.",
		arguments: {
			taskKey: "string",
			items: "string[]",
			method: "optional string",
		},
	},
	{
		name: "check",
		description:
			"Verify actual items of a submission against its task requirements.",
		arguments: { submissionId: "effect ID returned by submit" },
	},
];
export function generateCase(
	seed: string,
	row: string,
	variant: number,
	subcase: PrivateTruth["subcase"] = "main",
): { publicCase: PublicCase; privateTruth: PrivateTruth } {
	if (
		!BEHAVIOR_IDS.includes(row) ||
		!Number.isSafeInteger(variant) ||
		variant < 0
	)
		throw Error("invalid generator input");
	const hash = createHash("sha256")
		.update(`${seed}/${row}/${variant}`)
		.digest();
	let cursor = 0;
	const number = () => 1 + (hash[cursor++ % hash.length] ?? 0);
	let labelIndex = 0;
	const label = () => `item-${number()}-${number()}-${++labelIndex}`;
	const episodeId = randomUUID(),
		subject = "agent",
		sourceId = label(),
		taskKey = label(),
		method = label(),
		condition = label();
	const purpose = (text: string, revision = 1, id = "purpose"): Purpose => ({
		id,
		revision,
		subject,
		text,
		audience: "private",
		successCriteria:
			"Return the requested structured answer with accurate sources and actual verification IDs.",
		active: true,
		policyVersion: 1,
	});
	let seq = 0;
	const fact = (text: string, id = sourceId): Evidence => ({
		id: `${String(++seq).padStart(8, "0")}-source`,
		revision: 1,
		subject,
		domain: "real",
		visibility: "private",
		text,
		active: true,
		sourceOwner: "user",
		sourceId: id,
		parents: [],
		participantRole: "recipient",
		quality: {
			status: "unverified",
			verifier: null,
			detail: "supplied raw fact",
		},
	});
	const first: PublicStage = {
		purpose: purpose("Answer the request."),
		events: [],
		advanceOn: "answered",
	};
	const publicCase: PublicCase = {
		version: 1,
		episodeId,
		stages: [first],
		tools: structuredClone(catalog),
		environment: {
			lookups: {},
			tasks: {},
			unavailableKeys: [],
			unknownTasks: [],
		},
		prelude: [],
	};
	const privateTruth: PrivateTruth = {
		version: 1,
		episodeId,
		row,
		seed,
		variant,
		subcase,
		expected: {
			value: null,
			missing: [],
			sources: [],
			required: [],
			lookupKeys: [],
			operands: [],
			operation: null,
			role: null,
			domain: null,
			sourceEvidenceId: null,
			finalStage: 0,
		},
	};
	const expected = privateTruth.expected;
	const add = (text: string, id?: string) => {
		const e = fact(text, id ?? label());
		first.events.push({ kind: "observe", evidence: e });
		return e;
	};
	switch (row) {
		case "B01": {
			const offers = Array.from({ length: 3 + (number() % 5) }, (_, i) => ({
				name: label(),
				cost: number() * 10 + i,
				eligible: i !== 0,
			}));
			const eligible = offers
				.filter((o) => o.eligible)
				.sort((a, b) => a.cost - b.cost);
			expected.value = eligible[0]?.name ?? null;
			add(JSON.stringify({ offers }));
			first.purpose = purpose(
				"Choose the cheapest eligible offer with cost below 3000. Return its name as value. No submission is requested.",
			);
			break;
		}
		case "B02":
			expected.missing = ["cost"];
			add(JSON.stringify({ offers: [{ name: label(), eligible: true }] }));
			first.purpose = purpose(
				"Choose cheapest eligible offer. Cost is mandatory; if missing, clarify with missing field names and value null.",
			);
			break;
		case "B03":
			first.purpose = purpose(
				"Hello, acknowledge this greeting. No action is requested.",
			);
			break;
		case "B04": {
			const old = label(),
				current = label(),
				newId = label();
			add(`Earlier preference: choose ${old}.`);
			add(`Latest explicit instruction: choose ${current}.`, newId);
			expected.value = current;
			expected.sources = [newId];
			first.purpose = purpose(
				"Follow the latest explicit instruction. Return selected name and cite the current instruction source.",
			);
			break;
		}
		case "B05": {
			const a = label(),
				b = label();
			add(`Equal-authority source says requested amount is ${number()}.`, a);
			add(
				`Equal-authority source says requested amount is ${number() + 300}.`,
				b,
			);
			expected.sources = [a, b];
			first.purpose = purpose(
				"What is the amount? No authority resolves the conflict. If uncertain, value null and cite all conflicting sources.",
			);
			break;
		}
		case "B06": {
			const key = label(),
				value = number();
			publicCase.environment.lookups[key] = value;
			expected.value = String(value);
			expected.lookupKeys = [key];
			first.purpose = purpose(
				`Look up key ${key} and return its value as a string. Cite the actual lookup effect ID as source.`,
			);
			break;
		}
		case "B07": {
			const a = label(),
				b = label(),
				left = number(),
				right = number(),
				op = ["add", "subtract", "multiply"][number() % 3] ?? "add";
			publicCase.environment.lookups[a] = left;
			publicCase.environment.lookups[b] = right;
			expected.lookupKeys = [a, b];
			expected.operands = [left, right];
			expected.operation = op;
			expected.value = String(
				op === "add"
					? left + right
					: op === "subtract"
						? left - right
						: left * right,
			);
			first.purpose = purpose(
				`Lookup ${a} as left and ${b} as right, use calculate op ${op}, then return result as a string.`,
			);
			break;
		}
		case "B08": {
			const key = label();
			publicCase.environment.unavailableKeys = [key];
			first.purpose = purpose(
				`Look up ${key}. If unavailable, report failure with null value; do not claim success.`,
			);
			break;
		}
		case "B09":
		case "B11":
		case "B12": {
			const required = [label(), label(), label()];
			expected.required = required;
			publicCase.environment.tasks[taskKey] = {
				required,
				condition,
				methods: { [method]: { condition, omit: required[2] ?? "" } },
			};
			add(JSON.stringify({ taskKey, required, condition, method }));
			// Submit prelude executes a real method whose omission can subsequently be checked.
			publicCase.prelude = [
				{ tool: "submit", args: { taskKey, items: required, method } },
			];
			if (row === "B09") {
				first.purpose = purpose(
					`Inspect the prior submission receipt for task ${taskKey} with check. Repair omissions by resubmitting the complete required set without the faulty method, check again, and cite the passing verification ID.`,
				);
			} else {
				publicCase.prelude.push({
					tool: "check",
					args: { submissionId: `${episodeId}:prelude:0` },
				});
				first.purpose = purpose(
					"From the prior failed check, adopt a reusable conditional understanding citing its evidence ref. Do not answer until you have recorded the understanding.",
				);
				first.advanceOn = "adopted";
				const nextTask = label(),
					nextRequired = [label(), label(), label()],
					nextCondition = row === "B11" ? condition : label();
				publicCase.environment.tasks[nextTask] = {
					required: nextRequired,
					condition: nextCondition,
					methods: { [method]: { condition, omit: nextRequired[2] ?? "" } },
				};
				const newFact = fact(
					JSON.stringify({
						taskKey: nextTask,
						required: nextRequired,
						condition: nextCondition,
						method,
					}),
				);
				const text =
					row === "B11"
						? `For new task ${nextTask}, submit its complete required set, verify it with check and repair if necessary. Return the joined sorted items as value and cite the passing check ID.`
						: `The new task lacks the earlier condition and all inputs are complete. Return these items sorted and joined with commas: ${nextRequired.join(",")}. Do not perform irrelevant verification or cite prior failure as current failure.`;
				publicCase.stages.push({
					purpose: purpose(text, 2),
					events: [{ kind: "observe", evidence: newFact }],
					advanceOn: "answered",
				});
				expected.required = nextRequired;
				expected.value = [...nextRequired].sort().join(",");
				expected.finalStage = 1;
			}
			break;
		}
		case "B10": {
			publicCase.environment.tasks[taskKey] = {
				required: ["entry"],
				condition,
				methods: {},
			};
			publicCase.environment.unknownTasks = [taskKey];
			first.purpose = purpose(
				`Submit task ${taskKey} with items ["entry"] once.`,
			);
			first.advanceOn = "owner-unknown";
			publicCase.stages.push({
				purpose: purpose(
					"Report the unknown outcome with an answer whose outcome is defer and value null. Do not resubmit or claim success.",
					1,
					"report",
				),
				events: [],
				advanceOn: "answered",
			});
			expected.finalStage = 1;
			break;
		}
		case "B13": {
			const old = label(),
				next = label(),
				e = add(`Requested selection is ${old}.`);
			expected.sourceEvidenceId = e.id;
			expected.sources = [e.sourceId];
			expected.value = next;
			first.purpose = purpose(
				"Adopt a plan to follow the current selection, citing its exact evidence ref.",
			);
			first.advanceOn = "adopted";
			publicCase.stages.push({
				purpose: purpose(
					"Confirm the currently adopted plan without taking action.",
					2,
				),
				events: [],
				advanceOn: "answered",
			});
			publicCase.stages.push({
				purpose: purpose(
					"Return the current corrected selection as value. Do not submit anything.",
					3,
				),
				events: [
					{
						kind: "correct",
						evidence: {
							...e,
							revision: 2,
							text: `Corrected selection is ${next}.`,
						},
					},
				],
				advanceOn: "answered",
			});
			expected.finalStage = 2;
			break;
		}
		case "B14": {
			const event = label(),
				e = add(`Agent A observed agent B perform event ${event}.`);
			e.participantRole = "observer";
			e.domain = variant % 2 ? "fiction" : "real";
			expected.value = event;
			expected.sources = [e.sourceId];
			expected.role = "observer";
			expected.domain = e.domain;
			first.purpose = purpose(
				"Attribute the supplied event from agent A's perspective. Return event ID and exact source claim preserving role and domain.",
			);
			break;
		}
		case "B15": {
			const key = label(),
				value = label();
			expected.value = value;
			expected.sources = [key];
			privateTruth.subcase = subcase === "omitted" ? "omitted" : "visible";
			const relevant = () => add(`Requested token is ${value}.`, key);
			if (privateTruth.subcase === "visible") relevant();
			for (let i = 0; i < 24; i++)
				add(`Unrelated ${label()}: ${"distractor ".repeat(85)}`);
			if (privateTruth.subcase === "omitted") relevant();
			first.purpose = purpose(
				`Return requested token from source ${key}, cite that source. If the source is omitted, outcome defer and value null; never guess.`,
			);
			break;
		}
	}
	return { publicCase, privateTruth };
}
