import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { TaskError } from "../task-types.ts";

export function validateWorkspace(cwd: string): string {
	if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096)
		throw new TaskError(
			"workspace",
			"workspace must be an absolute existing directory",
		);
	if (!isAbsolute(cwd) || cwd.includes("\0"))
		throw new TaskError(
			"workspace",
			"workspace must be an absolute existing directory",
		);
	const resolved = resolve(cwd);
	if (resolved !== cwd)
		throw new TaskError("workspace", "workspace path must be canonical");
	let current = parse(resolved).root;
	for (const part of resolved
		.slice(current.length)
		.split(sep)
		.filter(Boolean)) {
		current = join(current, part);
		const stat = lstatSync(current, { throwIfNoEntry: false });
		if (!stat?.isDirectory() || stat.isSymbolicLink())
			throw new TaskError(
				"workspace",
				"workspace must be an absolute existing directory",
			);
	}
	if (realpathSync(resolved) !== resolved)
		throw new TaskError(
			"workspace",
			"workspace must be an absolute existing directory",
		);
	return resolved;
}
