import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "plan.ts");
const roots: string[] = [];
const gitEnv = {
	PATH: process.env["PATH"] ?? "",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "CI fixture",
	GIT_AUTHOR_EMAIL: "ci@example.invalid",
	GIT_COMMITTER_NAME: "CI fixture",
	GIT_COMMITTER_EMAIL: "ci@example.invalid",
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function git(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, env: gitEnv });
	if (result.exitCode !== 0) throw Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function write(root: string, path: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(
		join(root, path),
		path.endsWith(".json") ? "{}\n" : `fixture: ${path}\n`,
	);
}

function repo(paths: string[] = ["README.md"], format = "sha1") {
	const root = mkdtempSync(join(tmpdir(), "lina-ci-plan-"));
	roots.push(root);
	git(root, "init", "--template=", `--object-format=${format}`, "-b", "dev");
	for (const path of paths) write(root, path);
	const base = commit(root);
	return { root, base };
}

function commit(root: string): string {
	git(root, "add", "--all");
	git(
		root,
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"fixture",
	);
	return git(root, "rev-parse", "HEAD");
}

function mergeCandidate(content = "clean merge result\n") {
	const { root } = repo();
	git(root, "checkout", "-b", "feature");
	write(root, "docs/feature.md");
	const head = commit(root);
	git(root, "checkout", "dev");
	write(root, "docs/base.md");
	const base = commit(root);
	git(root, "merge", "--no-ff", "--no-commit", "feature");
	writeFileSync(join(root, "docs/merged.md"), content);
	const candidate = commit(root);
	return { root, base, head, candidate };
}

function run(
	root: string,
	base: string,
	env: Record<string, string | undefined> = {},
) {
	return Bun.spawnSync([process.execPath, script], {
		cwd: root,
		env: {
			...gitEnv,
			BASE_SHA: base,
			HEAD_SHA: git(root, "rev-parse", "HEAD"),
			BASE_REF: "dev",
			HEAD_REF: "feature/ci",
			HEAD_REPO: "owner/Lina",
			BASE_REPO: "owner/Lina",
			GITHUB_OUTPUT: join(root, "output"),
			...env,
		},
	});
}

function expectPlan(
	root: string,
	result: ReturnType<typeof run>,
	app: boolean,
	release = false,
): void {
	expect(result.stderr.toString()).toBe("");
	expect(result.exitCode).toBe(0);
	expect(readFileSync(join(root, "output"), "utf8")).toBe(
		`app=${app}\nrelease=${release}\n`,
	);
}

function expectFailure(
	root: string,
	result: ReturnType<typeof run>,
	reason: string,
): void {
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain("[ci-plan]");
	expect(result.stderr.toString()).toContain(reason);
	expect(existsSync(join(root, "output"))).toBe(false);
}

test.each([
	"README.md",
	"AGENTS.md",
	"POLICY.md",
	"CONTRIBUTING.md",
	"THIRD_PARTY_NOTICES.md",
	"docs/CI.md",
	"docs/nested/a guide.md",
	"devlog/_plan/010_ci.md",
	"docs/한글\tguide\nline.md",
])("only prose changes skip app checks: %s", (path) => {
	const { root, base } = repo(["initial.txt"]);
	write(root, path);
	commit(root);
	expectPlan(root, run(root, base), false);
});

test.each([
	"data/system-prompt.md",
	"data/personas/README.md",
	"packages/lina-core/README.md",
	"scripts/ci/plan.ts",
	".github/workflows/ci.yml",
	"bun.lock",
	"package.json",
	"tsconfig.json",
	"biome.json",
	".bun-version",
	"docs/example.ts",
	"docs/picture.svg",
	"devlog/run.sh",
	"UNKNOWN.md",
	"docs.md",
	"docs/config.MD",
	"docs/extension.md.ts",
	"README.md\nscript.ts",
])("non-allowlisted changes select app checks: %s", (path) => {
	const { root, base } = repo();
	write(root, path);
	commit(root);
	expectPlan(root, run(root, base), true);
});

test("mixed changes select app checks", () => {
	const { root, base } = repo();
	write(root, "docs/guide.md");
	write(root, "data/system-prompt.md");
	commit(root);
	expectPlan(root, run(root, base), true);
});

test("selection reads the entire diff beyond 300 documentation paths", () => {
	const { root, base } = repo();
	for (let index = 0; index < 350; index++) {
		write(root, `docs/guide-${index}.md`);
	}
	write(root, "z-runtime.ts");
	commit(root);
	expectPlan(root, run(root, base), true);
});

test("empty diff selects app checks", () => {
	const { root, base } = repo();
	expectPlan(root, run(root, base), true);
});

test.each([
	["data/system-prompt.md", true],
	["docs/old.md", false],
] as const)("deleted path is classified: %s", (path, app) => {
	const { root, base } = repo([path]);
	rmSync(join(root, path));
	commit(root);
	expectPlan(root, run(root, base), app);
});

test.each([
	["data/system-prompt.md", "docs/guide.md", true],
	["docs/guide.md", "data/system-prompt.md", true],
	["docs/old.md", "devlog/new.md", false],
] as const)(
	"both sides of rename are classified: %s -> %s",
	(from, to, app) => {
		const { root, base } = repo([from]);
		git(root, "config", "diff.renames", "true");
		mkdirSync(dirname(join(root, to)), { recursive: true });
		renameSync(join(root, from), join(root, to));
		commit(root);
		expectPlan(root, run(root, base), app);
	},
);

test("selection uses merge base, excluding base-only code changes", () => {
	const { root } = repo();
	git(root, "checkout", "-b", "feature");
	write(root, "docs/feature.md");
	const head = commit(root);
	git(root, "checkout", "dev");
	write(root, "packages/core.ts");
	const base = commit(root);
	expectPlan(root, run(root, base, { HEAD_SHA: head }), false);
});

test("summary records the exact checked-out merge candidate SHA", () => {
	const { root, base, head, candidate } = mergeCandidate();
	const result = run(root, base, {
		HEAD_SHA: head,
		GITHUB_STEP_SUMMARY: join(root, "summary"),
	});
	expectPlan(root, result, false);
	expect(candidate).not.toBe(base);
	expect(candidate).not.toBe(head);
	expect(readFileSync(join(root, "summary"), "utf8")).toContain(
		`Merge candidate: \`${candidate}\``,
	);
});

test("merge candidate whitespace errors fail before outputs or summary", () => {
	const { root, base, head } = mergeCandidate("trailing whitespace \n");
	const result = run(root, base, {
		HEAD_SHA: head,
		GITHUB_STEP_SUMMARY: join(root, "summary"),
	});
	expectFailure(root, result, "docs/merged.md:1");
	expect(result.stdout.toString()).toBe("");
	expect(existsSync(join(root, "summary"))).toBe(false);
});

test("same-repository dev promotion always selects app checks", () => {
	const { root, base } = repo();
	write(root, "docs/guide.md");
	commit(root);
	expectPlan(
		root,
		run(root, base, { BASE_REF: "main", HEAD_REF: "dev" }),
		true,
		true,
	);
});

test.each([
	{ HEAD_REF: "feature/fix" },
	{ HEAD_REF: "hotfix/fix" },
	{ HEAD_REF: "dev", HEAD_REPO: "fork/Lina" },
])("main rejects invalid promotion %j", (env) => {
	const { root, base } = repo();
	expectFailure(
		root,
		run(root, base, { BASE_REF: "main", ...env }),
		"same-repository dev",
	);
});

test("other bases and fork PRs receive development selection", () => {
	const { root, base } = repo();
	write(root, "docs/guide.md");
	commit(root);
	expectPlan(
		root,
		run(root, base, { BASE_REF: "feature/parent", HEAD_REPO: "fork/Lina" }),
		false,
	);
});

test.each([
	"BASE_SHA",
	"HEAD_SHA",
	"BASE_REF",
	"HEAD_REF",
	"BASE_REPO",
	"HEAD_REPO",
])("missing or empty required environment fails: %s", (key) => {
	const { root, base } = repo();
	for (const value of [undefined, "", " \t"]) {
		expectFailure(root, run(root, base, { [key]: value }), key);
	}
});

test.each(["BASE_SHA", "HEAD_SHA"])(
	"rejects malformed and non-commit SHAs: %s",
	(key) => {
		const { root, base } = repo();
		const blob = git(root, "rev-parse", "HEAD:README.md");
		git(
			root,
			"-c",
			"tag.gpgsign=false",
			"tag",
			"-a",
			"fixture-tag",
			"-m",
			"fixture",
		);
		const tag = git(root, "rev-parse", "fixture-tag");
		for (const value of [
			"HEAD",
			base.slice(0, 12),
			` ${base}`,
			`${base}\n`,
			"--help",
			"g".repeat(40),
			"a".repeat(39),
			"a".repeat(41),
			"0".repeat(40),
			blob,
			tag,
		]) {
			expectFailure(root, run(root, base, { [key]: value }), key);
		}
	},
);

test("full SHA-256 commit IDs work in SHA-256 repositories", () => {
	const { root, base } = repo(["README.md"], "sha256");
	write(root, "docs/guide.md");
	commit(root);
	expectPlan(root, run(root, base), false);
});

test("unrelated histories fail rather than selecting docs-only", () => {
	const { root, base } = repo();
	git(root, "checkout", "--orphan", "unrelated");
	write(root, "docs/new.md");
	commit(root);
	expectFailure(root, run(root, base), "merge-base");
});

test("unreadable diff fails without emitting selection outputs", () => {
	const { root, base } = repo();
	write(root, "docs/guide.md");
	commit(root);
	const tree = git(root, "rev-parse", "HEAD^{tree}");
	rmSync(join(root, ".git/objects", tree.slice(0, 2), tree.slice(2)));
	expectFailure(root, run(root, base), "diff");
});

test("missing git executable fails without emitting selection outputs", () => {
	const { root, base } = repo();
	expectFailure(root, run(root, base, { PATH: root }), "BASE_SHA");
});

test("CLI supports absent output files and appends outputs and summary when supplied", () => {
	const { root, base } = repo();
	write(root, "docs/guide.md");
	const head = commit(root);
	const standalone = run(root, base, { GITHUB_OUTPUT: "" });
	expect(standalone.exitCode).toBe(0);
	expect(existsSync(join(root, "output"))).toBe(false);
	writeFileSync(join(root, "output"), "existing=value\n");
	writeFileSync(join(root, "summary"), "existing summary\n");
	const result = run(root, base, {
		GITHUB_STEP_SUMMARY: join(root, "summary"),
	});
	expect(result.exitCode).toBe(0);
	expect(readFileSync(join(root, "output"), "utf8")).toBe(
		"existing=value\napp=false\nrelease=false\n",
	);
	const summary = readFileSync(join(root, "summary"), "utf8");
	expect(summary).toStartWith("existing summary\n");
	expect(summary).toContain(base);
	expect(summary).toContain(head);
});

test("unwritable output fails at the CLI boundary", () => {
	const { root, base } = repo();
	expectFailure(root, run(root, base, { GITHUB_OUTPUT: root }), "EISDIR");
});

test("unwritable summary fails before emitting selection outputs", () => {
	const { root, base } = repo();
	expectFailure(root, run(root, base, { GITHUB_STEP_SUMMARY: root }), "EISDIR");
});

test("importing the selector does not execute the CLI", () => {
	const result = Bun.spawnSync(
		[
			process.execPath,
			"--eval",
			`await import(${JSON.stringify(script)}); console.log('imported')`,
		],
		{ env: gitEnv },
	);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toBe("imported\n");
	expect(result.stderr.toString()).toBe("");
});
