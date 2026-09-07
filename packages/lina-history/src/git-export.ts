import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { atomicWrite, resolveDirectory } from "./paths.ts";
import type { CheckpointManifest } from "./types.ts";

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export function exportManifestToGit(
	historyRoot: string,
	manifest: CheckpointManifest,
): string | undefined {
	const vcs = join(historyRoot, "vcs");
	const hooks = join(vcs, ".empty-hooks");
	const template = join(vcs, ".empty-template");
	resolveDirectory(join(vcs, "manifests"), true);
	resolveDirectory(hooks, true);
	resolveDirectory(template, true);
	const relative = `manifests/${manifest.id}.json`;
	atomicWrite(
		join(vcs, relative),
		Buffer.from(
			`${JSON.stringify({
				id: manifest.id,
				createdAt: manifest.createdAt,
				reason: manifest.reason,
				complete: manifest.complete,
				coverageGaps: manifest.coverageGaps,
				exclusions: manifest.exclusions,
				files: manifest.files,
			})}
`,
		),
	);
	const flags = [
		"-c",
		`core.hooksPath=${hooks}`,
		"-c",
		"commit.gpgsign=false",
		"-c",
		"tag.gpgsign=false",
		"-c",
		`init.templateDir=${template}`,
		"-c",
		"user.name=lina-history",
		"-c",
		"user.email=lina-history@local",
	];
	if (git(vcs, flags, ["init", "-q"]) !== 0)
		return "git manifest export skipped";
	if (git(vcs, flags, ["add", "--", relative]) !== 0)
		return "git manifest export skipped";
	if (
		git(vcs, flags, [
			"commit",
			"--only",
			"-q",
			"-m",
			`checkpoint ${manifest.id}`,
			"--",
			relative,
		]) !== 0
	)
		return "git manifest export skipped";
	return undefined;
}

function git(cwd: string, flags: string[], args: string[]): number {
	const inherited: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("GIT_")) continue;
		inherited[key] = value;
	}
	const result = spawnSync("git", [...flags, ...args], {
		cwd,
		env: {
			...inherited,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: NULL_DEVICE,
			GIT_CONFIG_SYSTEM: NULL_DEVICE,
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		},
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) return 1;
	return result.status ?? 1;
}
