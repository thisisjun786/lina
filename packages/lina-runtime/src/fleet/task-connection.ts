import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	atomicJson,
	checkedDirectory,
	readRegular,
} from "../../../lina-core/src/attachments/filesystem.ts";

/** A saved connection mode prevents resuming task IDs in the wrong Codex home. */
export function taskConnectionSpec(input: {
	stateRoot: string;
	homeDir: string;
	env: NodeJS.ProcessEnv;
	defaultMode?: "owned" | "shared";
}): { mode: "shared"; socket: string } | { mode: "owned"; stateRoot: string } {
	const path = join(
		checkedDirectory(input.stateRoot, true),
		"task-runtime.json",
	);
	let saved: { mode: "owned" | "shared"; target: string } | undefined;
	if (existsSync(path)) {
		const value: unknown = JSON.parse(
			new TextDecoder().decode(readRegular(path)),
		);
		if (
			!value ||
			typeof value !== "object" ||
			!("version" in value) ||
			value.version !== 1 ||
			!("mode" in value) ||
			(value.mode !== "owned" && value.mode !== "shared") ||
			!("target" in value) ||
			typeof value.target !== "string" ||
			Object.keys(value).length !== 3
		)
			throw Error("Invalid task runtime binding");
		saved = { mode: value.mode, target: value.target };
	}
	const mode =
		input.env["LINA_CODEX_TASK_MODE"] ??
		saved?.mode ??
		input.defaultMode ??
		"shared";
	if (mode !== "owned" && mode !== "shared")
		throw Error("Invalid LINA_CODEX_TASK_MODE");
	if (mode === "owned" && input.env["LINA_CODEX_SOCKET"] !== undefined)
		throw Error("LINA_CODEX_SOCKET conflicts with owned task mode");
	const socket =
		input.env["LINA_CODEX_SOCKET"] ??
		join(
			input.env["CODEX_HOME"] ?? join(input.homeDir, ".codex"),
			"app-server-control",
			"app-server-control.sock",
		);
	if (mode === "shared" && !socket.trim())
		throw Error("Invalid LINA_CODEX_SOCKET");
	const target = resolve(
		mode === "owned" ? join(input.stateRoot, "task-engine") : socket,
	);
	if (saved) {
		if (saved.mode !== mode || saved.target !== target)
			throw Error(
				"Task engine binding changed; explicit migration is required",
			);
	} else {
		if (mode === "owned" && existsSync(join(input.stateRoot, "tasks.sqlite")))
			throw Error("Existing tasks require shared mode or explicit migration");
		atomicJson(path, { version: 1, mode, target });
	}
	return mode === "owned"
		? { mode, stateRoot: target }
		: { mode, socket: target };
}
