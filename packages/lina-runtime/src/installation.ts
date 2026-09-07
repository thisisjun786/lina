import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readRegular } from "../../lina-core/src/attachments/filesystem.ts";
import { resolveLinaPaths } from "../../lina-core/src/installation/paths.ts";
import { validateBinding } from "../../lina-core/src/session-binding.ts";

export function boundWorkspace(
	stateRoot: string,
	proposed: string,
	explicit = false,
): string {
	const file = join(stateRoot, "binding.json");
	if (!existsSync(file)) return proposed;
	const binding = validateBinding(
		JSON.parse(new TextDecoder().decode(readRegular(file))),
	);
	if (explicit && resolve(proposed) !== binding.workspace)
		throw Error(
			"Existing session workspace differs; explicit migration is required",
		);
	return binding.workspace;
}

export function resolveStartup(input: {
	resourceRoot: string;
	cwd?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}) {
	const env = input.env ?? process.env;
	const cwd = input.cwd ?? process.cwd();
	const homeDir = input.homeDir ?? homedir();
	const paths = resolveLinaPaths({ env, cwd, homeDir });
	if (existsSync(join(paths.home, "restore-review.json")))
		throw Error(
			"Staged restore requires binding and permission review before startup",
		);
	if (
		!env["LINA_HOME"] &&
		!env["LINA_STATE_DIR"] &&
		[".lina-codex-state", ".lina-state"].some((name) =>
			existsSync(join(cwd, name)),
		)
	)
		throw Error(
			"Existing state detected. Set LINA_STATE_DIR and LINA_WORKSPACE explicitly; no automatic migration is performed",
		);
	const requested = env["LINA_WORKSPACE"];
	if (requested !== undefined && !requested.trim())
		throw Error("Invalid LINA_WORKSPACE");
	const selected = requested?.startsWith("~/")
		? join(homeDir, requested.slice(2))
		: requested;
	if (selected !== undefined && !isAbsolute(selected))
		throw Error("LINA_WORKSPACE must be absolute");
	const legacy = !!env["LINA_STATE_DIR"] && !env["LINA_HOME"];
	const proposed =
		selected ?? (legacy ? cwd : join(paths.workspaceRoot, "lina"));
	return {
		paths,
		resourceRoot: resolve(input.resourceRoot),
		stateRoot: paths.stateRoot,
		workspace: boundWorkspace(
			paths.stateRoot,
			resolve(proposed),
			selected !== undefined,
		),
		...(!legacy && selected === undefined
			? { workspaceRoot: paths.workspaceRoot }
			: {}),
	};
}
