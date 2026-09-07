import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import {
	parseSessionContextPolicy,
	type SessionContextPolicy,
} from "../src/context-policy.ts";
import type { SdkSessionOptions } from "../src/host.ts";
import { type AppOptions, startPersistentApp } from "../src/session-app.ts";
import type { SessionEngine } from "../src/session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

export type { SdkSessionOptions } from "../src/host.ts";

/** Test-owned identity format: no native SDK and never used by product startup. */
export function initializeSessionFile(
	file: string,
	workspace: string,
	policy?: SessionContextPolicy,
) {
	if (policy) parseSessionContextPolicy(policy);
	const cwd = realpathSync(workspace);
	if (!existsSync(file) || readFileSync(file, "utf8") === "") {
		writeFileSync(
			file,
			JSON.stringify({ engine: "fixture-codex", cwd, id: randomUUID() }) + "\n",
			{ mode: 0o600 },
		);
	}
	const value = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "");
	if (
		value.engine !== "fixture-codex" ||
		value.cwd !== cwd ||
		typeof value.id !== "string"
	)
		throw Error("Fixture session identity does not match");
	return { sessionId: value.id as string, sessionFile: realpathSync(file) };
}
export function testSessionEngine(): SessionEngine {
	return {
		kind: "codex",
		inspect(file, workspace) {
			if (readFileSync(file, "utf8")) initializeSessionFile(file, workspace);
		},
		initialize: initializeSessionFile,
		async create(options: SdkSessionOptions) {
			const identity = initializeSessionFile(
				options.sessionFile,
				options.workspace,
				options.contextPolicy,
			);
			return new ControlledSession(identity.sessionId, identity.sessionFile);
		},
	};
}
export function startTestApp(
	options: Omit<AppOptions, "engine"> & { engine?: SessionEngine },
) {
	return startPersistentApp({ engine: testSessionEngine(), ...options });
}
