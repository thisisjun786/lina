import { homedir } from "node:os";
import * as nodePath from "node:path";

export type LinaPathFlavor = {
	readonly sep: string;
	isAbsolute(path: string): boolean;
	join(...paths: string[]): string;
	resolve(...paths: string[]): string;
};

export type ResolveLinaPathsInput = {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	flavor?: LinaPathFlavor;
};

export type LinaPaths = {
	home: string;
	stateRoot: string;
	workspaceRoot: string;
	historyRoot: string;
	runtimeRoot: string;
	credentialsRoot: string;
	skillsRoot: string;
	logsRoot: string;
	cacheRoot: string;
	configPath: string;
};

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const raw = env[key];
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (value.length === 0) throw Error(`${key} must not be empty`);
	return value;
}

function expandHome(
	value: string,
	homeDir: string,
	flavor: LinaPathFlavor,
): string {
	if (value === "~") return flavor.resolve(homeDir);
	if (value.startsWith("~/") || value.startsWith("~\\"))
		return flavor.resolve(homeDir, value.slice(2));
	return value;
}

function absolute(
	label: string,
	value: string,
	flavor: LinaPathFlavor,
): string {
	if (!flavor.isAbsolute(value))
		throw Error(`${label} must be an absolute path`);
	return flavor.resolve(value);
}

export function resolveLinaPaths(input: ResolveLinaPathsInput = {}): LinaPaths {
	const flavor = input.flavor ?? nodePath;
	const env = input.env ?? process.env;
	const homeDir = absolute("homeDir", input.homeDir ?? homedir(), flavor);
	const cwd = absolute("cwd", input.cwd ?? process.cwd(), flavor);
	const configured = readEnv(env, "LINA_HOME");
	const home =
		configured === undefined
			? flavor.resolve(homeDir, ".lina")
			: absolute("LINA_HOME", expandHome(configured, homeDir, flavor), flavor);
	const state = readEnv(env, "LINA_STATE_DIR");
	const stateRoot =
		state === undefined
			? flavor.join(home, "state")
			: flavor.isAbsolute(state)
				? flavor.resolve(state)
				: flavor.resolve(cwd, state);
	return {
		home,
		stateRoot,
		workspaceRoot: flavor.join(home, "workspaces"),
		historyRoot: flavor.join(home, "history"),
		runtimeRoot: flavor.join(home, "runtime"),
		credentialsRoot: flavor.join(home, "credentials"),
		skillsRoot: flavor.join(home, "skills"),
		logsRoot: flavor.join(home, "logs"),
		cacheRoot: flavor.join(home, "cache"),
		configPath: flavor.join(home, "config.json"),
	};
}
