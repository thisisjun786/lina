import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	checkedDirectory,
	readRegular,
} from "../../lina-core/src/attachments/filesystem.ts";
import { resolveLinaPaths } from "../../lina-core/src/installation/paths.ts";
import {
	createCheckpoint,
	diffCheckpoints,
	listCheckpoints,
	restoreCheckpoint,
	verifyCheckpoint,
} from "../../lina-history/src/index.ts";
import { acquireCheckpointBarrier } from "./checkpoint-barrier.ts";

export function checkpointCommand(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
) {
	const paths = resolveLinaPaths({ env });
	const [action, first, second] = args;
	if (command === "restore") {
		if (args.length !== 2 || !action || !first || !isAbsolute(first))
			throw Error("Usage: lina restore <id> <new-absolute-directory>");
		return restoreCheckpoint(paths.historyRoot, action, first);
	}
	if (action === "list" && args.length === 1)
		return listCheckpoints(paths.historyRoot);
	if (action === "verify" && first && args.length === 2)
		return verifyCheckpoint(paths.historyRoot, first);
	if (action === "diff" && first && second && args.length === 3)
		return diffCheckpoints(paths.historyRoot, first, second);
	const exportGit = first === "--git";
	if (action !== "create" || args.length > (exportGit ? 3 : 2))
		throw Error(
			"Usage: lina checkpoint create [--git] [reason] | list | verify <id> | diff <left> <right>",
		);
	checkedDirectory(paths.stateRoot, false);
	const barrier = acquireCheckpointBarrier(paths.stateRoot);
	let staging: string | undefined;
	try {
		staging = mkdtempSync(join(tmpdir(), "lina-checkpoint-config-"));
		const components = [{ name: "state", root: paths.stateRoot }];
		for (const [name, root] of [
			["skills", paths.skillsRoot],
			["agents", join(paths.home, "agents")],
		] as const) {
			if (existsSync(root)) components.push({ name, root });
		}
		if (existsSync(paths.configPath)) {
			writeFileSync(
				join(staging, "config.json"),
				readRegular(paths.configPath),
				{ mode: 0o600, flag: "wx" },
			);
			components.push({ name: "configuration", root: staging });
		}
		return createCheckpoint({
			historyRoot: paths.historyRoot,
			components,
			reason: (exportGit ? second : first) ?? "Manual agent state checkpoint",
			exportGit,
			coverageGaps: [
				"Data outside the selected local component roots is not exported; back it up separately.",
				"Shared Codex task history, external session files, user workspaces and external skill roots require separate backup.",
				"Provider credentials, process environment, packaged assets and runtime release require separate recovery.",
			],
		});
	} finally {
		try {
			if (staging) rmSync(staging, { recursive: true, force: true });
		} finally {
			barrier.close();
		}
	}
}
