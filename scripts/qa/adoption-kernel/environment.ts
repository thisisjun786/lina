// biome-ignore-all lint/complexity/useLiteralKeys: persisted and tool input records.
import { DatabaseSync } from "node:sqlite";
import type { PublicCase, ToolName, ToolResultEvent } from "./harness-types.ts";
import type { JsonValue, ToolPort, ToolReceipt } from "./types.ts";
import { parseJson, parseReceipt } from "./validation.ts";

function object(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid tool arguments");
	return value;
}
function word(value: JsonValue | undefined): string {
	if (typeof value !== "string" || !value) throw Error("missing tool argument");
	return value;
}
export class Environment {
	private readonly db: DatabaseSync;
	private readonly ports = new Map<string, ToolPort>();
	constructor(
		private readonly input: PublicCase,
		path = ":memory:",
	) {
		this.db = new DatabaseSync(path);
		this.db.exec(
			"CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY,tool TEXT NOT NULL,args TEXT NOT NULL,fence TEXT NOT NULL,receipt TEXT NOT NULL) STRICT",
		);
		for (const spec of input.tools)
			this.ports.set(spec.name, {
				admit: (id, args, fence) => this.admit(spec.name, id, args, fence),
				result: async (id) => this.read(id),
				reconcile: async (id) => this.read(id),
			});
	}
	tools(): ReadonlyMap<string, ToolPort> {
		return this.ports;
	}
	close(): void {
		this.db.close();
	}
	events(): ToolResultEvent[] {
		return this.db
			.prepare("SELECT id,tool,args,receipt FROM effects ORDER BY rowid")
			.all()
			.map((row) => ({
				effectId: String(row["id"]),
				tool: String(row["tool"]),
				args: parseJson(JSON.parse(String(row["args"]))),
				receipt: parseReceipt(JSON.parse(String(row["receipt"]))),
			}));
	}
	private read(id: string): ToolReceipt | null {
		const row = this.db
			.prepare("SELECT receipt FROM effects WHERE id=?")
			.get(id);
		return row ? parseReceipt(JSON.parse(String(row["receipt"]))) : null;
	}
	private admit(
		tool: ToolName,
		id: string,
		args: JsonValue,
		fence: string,
	): void {
		const text = JSON.stringify(parseJson(args));
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const prior = this.db
				.prepare("SELECT tool,args,fence FROM effects WHERE id=?")
				.get(id);
			if (prior) {
				if (
					prior["tool"] !== tool ||
					prior["args"] !== text ||
					prior["fence"] !== fence
				)
					throw Error("conflicting owner replay");
			} else {
				let receipt: ToolReceipt;
				try {
					receipt = this.execute(tool, id, args);
				} catch {
					receipt = {
						effectId: id,
						status: "failed",
						output: { error: "invalid or unavailable tool request" },
						quality: {
							status: "unverified",
							verifier: null,
							detail: "owner rejected request",
						},
					};
				}
				if (JSON.stringify({ effectId: id, tool, args, receipt }).length > 4096)
					throw Error("environment event exceeds bound");
				this.db
					.prepare("INSERT INTO effects VALUES (?,?,?,?,?)")
					.run(id, tool, text, fence, JSON.stringify(receipt));
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private execute(tool: ToolName, id: string, input: JsonValue): ToolReceipt {
		const args = object(input);
		const result: ToolReceipt = {
			effectId: id,
			status: "completed",
			output: null,
			quality: {
				status: "unverified",
				verifier: null,
				detail: "owner completed operation",
			},
		};
		if (tool === "lookup") {
			const key = word(args["key"]);
			if (
				this.input.environment.unavailableKeys.includes(key) ||
				!Object.hasOwn(this.input.environment.lookups, key)
			)
				throw Error("unavailable lookup");
			result.output = {
				key,
				value: this.input.environment.lookups[key] ?? null,
			};
		} else if (tool === "calculate") {
			const left = args["left"],
				right = args["right"],
				op = args["op"];
			if (
				typeof left !== "number" ||
				typeof right !== "number" ||
				!Number.isSafeInteger(left) ||
				!Number.isSafeInteger(right)
			)
				throw Error("invalid operands");
			const value =
				op === "add"
					? left + right
					: op === "subtract"
						? left - right
						: op === "multiply"
							? left * right
							: NaN;
			if (!Number.isSafeInteger(value)) throw Error("invalid arithmetic");
			result.output = { value };
		} else if (tool === "submit") {
			const taskKey = word(args["taskKey"]),
				task = this.input.environment.tasks[taskKey];
			if (
				!task ||
				!Array.isArray(args["items"]) ||
				!args["items"].every((x) => typeof x === "string")
			)
				throw Error("invalid submission");
			let items = args["items"] as string[];
			const method =
				typeof args["method"] === "string"
					? task.methods[args["method"]]
					: undefined;
			if (method && method.condition === task.condition)
				items = items.filter((x) => x !== method.omit);
			result.output = { taskKey, items };
			if (this.input.environment.unknownTasks.includes(taskKey)) {
				result.status = "unknown";
				result.output = { taskKey, status: "unknown" };
			}
		} else {
			const submissionId = word(args["submissionId"]);
			const row = this.db
				.prepare("SELECT tool,receipt FROM effects WHERE id=?")
				.get(submissionId);
			if (!row || row["tool"] !== "submit") throw Error("unknown submission");
			const submitted = parseReceipt(JSON.parse(String(row["receipt"])));
			if (submitted.status !== "completed")
				throw Error("submission not completed");
			const output = object(submitted.output),
				task = this.input.environment.tasks[word(output["taskKey"])];
			if (!task || !Array.isArray(output["items"]))
				throw Error("invalid submission output");
			const items = output["items"];
			const missing = task.required.filter((x) => !items.includes(x));
			const extra = items.filter(
				(x) => typeof x !== "string" || !task.required.includes(x),
			);
			const pass =
				missing.length === 0 &&
				extra.length === 0 &&
				new Set(items).size === items.length;
			result.output = { submissionId, missing, extra, pass };
			result.quality = {
				status: pass ? "pass" : "fail",
				verifier: id,
				detail: pass ? "required set verified" : "required set mismatch",
			};
		}
		return parseReceipt(result);
	}
}
