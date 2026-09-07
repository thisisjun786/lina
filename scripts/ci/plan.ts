import { appendFileSync } from "node:fs";

const rootDocs = new Set([
	"README.md",
	"AGENTS.md",
	"POLICY.md",
	"CONTRIBUTING.md",
	"THIRD_PARTY_NOTICES.md",
]);
const fullCommitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value?.trim()) throw Error(`${name} is required`);
	return value;
}

function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args]);
	if (result.exitCode !== 0) {
		const detail =
			`${result.stdout.toString()}${result.stderr.toString()}`.trim();
		throw Error(`git ${args[0]} failed: ${detail}`);
	}
	return result.stdout.toString();
}

function commitId(name: string): string {
	const sha = requiredEnv(name);
	if (!fullCommitId.test(sha)) {
		throw Error(`${name} must be a full hexadecimal commit ID`);
	}
	try {
		if (git("cat-file", "-t", sha).trim() !== "commit") {
			throw Error("object is not a commit");
		}
	} catch (error) {
		throw Error(
			`${name}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return sha;
}

function changedPaths(
	base: string,
	head: string,
): { mergeBase: string; paths: string[] } {
	const mergeBase = git("merge-base", base, head).trim();
	if (!fullCommitId.test(mergeBase))
		throw Error("Invalid git merge-base output");
	// Disabling rename detection keeps both the deleted and added path in scope.
	const diff = git(
		"diff",
		"--name-only",
		"--no-renames",
		"-z",
		mergeBase,
		head,
		"--",
	);
	if (diff === "") return { mergeBase, paths: [] };
	if (!diff.endsWith("\0")) throw Error("Git diff is not NUL-terminated");
	const paths = diff.slice(0, -1).split("\0");
	if (paths.some((path) => path === ""))
		throw Error("Git diff contains an empty path");
	return { mergeBase, paths };
}

function isProse(path: string): boolean {
	return (
		rootDocs.has(path) ||
		((path.startsWith("docs/") || path.startsWith("devlog/")) &&
			path.endsWith(".md"))
	);
}

function main(): void {
	const baseRef = requiredEnv("BASE_REF");
	const headRef = requiredEnv("HEAD_REF");
	const baseRepo = requiredEnv("BASE_REPO");
	const headRepo = requiredEnv("HEAD_REPO");
	const base = commitId("BASE_SHA");
	const head = commitId("HEAD_SHA");
	const release = baseRef === "main";
	if (release && (headRef !== "dev" || headRepo !== baseRepo)) {
		throw Error("main requires a same-repository dev promotion");
	}
	const { mergeBase, paths } = changedPaths(base, head);
	git("diff", "--check", mergeBase, "HEAD", "--");
	const candidate = git("rev-parse", "HEAD").trim();
	const app = release || paths.length === 0 || !paths.every(isProse);
	const output = `app=${app}\nrelease=${release}\n`;
	const summary = [
		"## CI selection",
		`Base commit: \`${base}\``,
		`Head commit: \`${head}\``,
		`Merge base: \`${mergeBase}\``,
		`Merge candidate: \`${candidate}\``,
		`Changed paths: ${paths.length}`,
		`Application checks: ${app}; release: ${release}`,
		"",
	].join("\n");
	const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
	if (summaryFile) appendFileSync(summaryFile, summary);
	const outputFile = process.env["GITHUB_OUTPUT"];
	if (outputFile) appendFileSync(outputFile, output);
	process.stdout.write(output);
}

if (import.meta.main) {
	try {
		main();
	} catch (error) {
		console.error(
			"[ci-plan]",
			error instanceof Error ? error.message : String(error),
		);
		process.exitCode = 1;
	}
}
