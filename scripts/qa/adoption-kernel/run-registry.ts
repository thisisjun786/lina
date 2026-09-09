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
	private generationTables(): void {
		this.db.exec(`CREATE TABLE IF NOT EXISTS generations(seed TEXT PRIMARY KEY, freezeHash TEXT NOT NULL, startedAt TEXT NOT NULL) STRICT;
            CREATE TABLE IF NOT EXISTS generated(seed TEXT PRIMARY KEY REFERENCES generations(seed), manifestPath TEXT NOT NULL, manifestHash TEXT NOT NULL, finishedAt TEXT NOT NULL) STRICT;`);
	}
	beginGeneration(seed: string, freezeHash: string): void {
		if (!seed || !/^[a-f0-9]{64}$/.test(freezeHash))
			throw Error("invalid generation identity");
		this.generationTables();
		this.db
			.prepare("INSERT INTO generations VALUES(?,?,?)")
			.run(seed, freezeHash, new Date().toISOString());
	}
	finishGeneration(
		seed: string,
		manifestPath: string,
		manifestHash: string,
	): void {
		if (!isAbsolute(manifestPath) || !/^[a-f0-9]{64}$/.test(manifestHash))
			throw Error("invalid generated artifact");
		this.generationTables();
		this.db
			.prepare("INSERT INTO generated VALUES(?,?,?,?)")
			.run(seed, manifestPath, manifestHash, new Date().toISOString());
	}
	generation(seed: string): {
		freezeHash: string;
		startedAt: string;
		manifestPath: string | null;
		manifestHash: string | null;
		finishedAt: string | null;
	} | null {
		this.generationTables();
		const row = this.db
			.prepare(
				"SELECT g.freezeHash,g.startedAt,d.manifestPath,d.manifestHash,d.finishedAt FROM generations g LEFT JOIN generated d ON g.seed=d.seed WHERE g.seed=?",
			)
			.get(seed);
		if (!row) return null;
		const { freezeHash, startedAt, manifestPath, manifestHash, finishedAt } =
			row;
		if (
			typeof freezeHash !== "string" ||
			typeof startedAt !== "string" ||
			(manifestPath !== null && typeof manifestPath !== "string") ||
			(manifestHash !== null && typeof manifestHash !== "string") ||
			(finishedAt !== null && typeof finishedAt !== "string")
		)
			throw Error("invalid generation record");
		return { freezeHash, startedAt, manifestPath, manifestHash, finishedAt };
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
	qualificationCandidates(sourceHash: string, frozenAt: string): RunEntry[] {
		const freeze = Date.parse(frozenAt);
		if (!Number.isFinite(freeze) || !/^[a-f0-9]{64}$/.test(sourceHash))
			throw Error("invalid candidate freeze");
		const entries = this.entries();
		const last = entries.slice(-3);
		if (last.length !== 3) throw Error("three attempts required");
		for (const entry of last) {
			const start = Date.parse(entry.startedAt);
			const end = entry.endedAt === null ? NaN : Date.parse(entry.endedAt);
			if (
				entry.purpose !== "qualification" ||
				entry.state !== "completed" ||
				entry.sourceHash !== sourceHash ||
				!Number.isFinite(start) ||
				!Number.isFinite(end) ||
				start < freeze ||
				end < start ||
				entries.filter((other) => other.seed === entry.seed).length !== 1
			)
				throw Error(
					"last three attempts are not fresh completed qualification candidates",
				);
		}
		return last;
	}
	close(): void {
		this.db.close();
	}
}
