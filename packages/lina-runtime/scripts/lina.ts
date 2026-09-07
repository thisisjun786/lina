#!/usr/bin/env bun
import { resolveLinaPaths } from "../../lina-core/src/installation/paths.ts";

const [command = "help", ...args] = process.argv.slice(2);
try {
	if (command === "help" || command === "--help") {
		console.log(`LINA — Lifelong Intelligent Networked Agent

Usage: lina <command>
  paths                         Show resolved installation paths
  start                         Start the agent controller
  web                           Start the web interface
  checkpoint create [--git] [reason] Capture offline local agent state
  checkpoint list              List saved checkpoints
  checkpoint verify <id>       Verify manifest and all payloads
  checkpoint diff <left> <right> Compare saved states
  restore <id> <new-directory>  Stage recovery without changing this installation

LINA_HOME defaults to ~/.lina. Existing LINA_STATE_DIR remains supported.
Checkpoint/restore requires the runtime to be stopped; external stores are reported separately.`);
	} else if (command === "paths" && args.length === 0) {
		console.log(JSON.stringify(resolveLinaPaths(), null, 2));
	} else if (command === "start" && args.length === 0) {
		await import("./start-codex.ts");
	} else if (command === "web" && args.length === 0) {
		await import("../../lina-web/scripts/start.ts");
	} else if (command === "checkpoint" || command === "restore") {
		const { checkpointCommand } = await import("../src/checkpoint-cli.ts");
		console.log(JSON.stringify(checkpointCommand(command, args), null, 2));
	} else throw Error("Unknown command or arguments. Run lina help.");
} catch (error) {
	console.error(error instanceof Error ? error.message : "Lina command failed");
	process.exitCode = 1;
}
