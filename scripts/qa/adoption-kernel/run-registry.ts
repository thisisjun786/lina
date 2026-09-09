import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RegisteredRun = {
	output: string;
	seed: string;
	purpose: "development" | "qualification";
	manifestPath: string;
	manifestHash: string;
	sourceHash: string;
};
export type RunEntry = RegisteredRun & {
	sequence: number;
	startedAt: string;
	endedAt: string | null;
	state: "started" | "completed" | "failed";
};
function decode(value: unknown): RegisteredRun {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid run identity");
	const row = value as RegisteredRun;
	if (
		Object.keys(row).sort().join() !==
			[
				"output",
				"seed",
				"purpose",
				"manifestPath",
				"manifestHash",
				"sourceHash",
			]
				.sort()
				.join() ||
		typeof row.output !== "string" ||
		!isAbsolute(row.output) ||
		typeof row.manifestPath !== "string" ||
		!isAbsolute(row.manifestPath) ||
		typeof row.seed !== "string" ||
		!row.seed ||
		!["development", "qualification"].includes(row.purpose) ||
		![row.manifestHash, row.sourceHash].every(
			(hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
		)
	)
		throw Error("invalid run identity");
	return structuredClone(row);
}
export class RunRegistry {
	private readonly db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
   CREATE TABLE IF NOT EXISTS attempts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, output TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, started TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS completions (output TEXT PRIMARY KEY REFERENCES attempts(output), state TEXT NOT NULL CHECK(state IN ('completed','failed')), ended TEXT NOT NULL) STRICT;`);
	}
	begin(value: RegisteredRun): void {
		const row = decode(value);
		this.db
			.prepare("INSERT INTO attempts(output,payload,started) VALUES(?,?,?)")
			.run(row.output, JSON.stringify(row), new Date().toISOString());
	}
	finish(output: string, state: "completed" | "failed"): void {
		this.db
			.prepare("INSERT INTO completions(output,state,ended) VALUES(?,?,?)")
			.run(output, state, new Date().toISOString());
	}
	entries(): RunEntry[] {
		return this.db
			.prepare(
				"SELECT a.sequence,a.output,a.payload,a.started,c.state,c.ended FROM attempts a LEFT JOIN completions c ON a.output=c.output ORDER BY a.sequence",
			)
			.all()
			.map((value) => {
				const { sequence, output, payload, started, state, ended } = value;
				if (
					typeof sequence !== "number" ||
					typeof payload !== "string" ||
					typeof started !== "string" ||
					(state !== null && state !== "completed" && state !== "failed") ||
					(ended !== null && typeof ended !== "string")
				)
					throw Error("invalid registry record");
				const identity = decode(JSON.parse(payload));
				if (identity.output !== output)
					throw Error("registry identity mismatch");
				return {
					...identity,
					sequence,
					startedAt: started,
					endedAt: ended,
					state: state ?? "started",
				};
			});
	}
	close(): void {
		this.db.close();
	}
}
