import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	atomicJson,
	checkedDirectory,
	checkedRegular,
	readRegular,
} from "../../lina-core/src/attachments/filesystem.ts";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";

type InstallInput = {
	source: string;
	home: string;
	prepare?: (release: string) => Promise<void>;
};
const ignored = new Set([
	"node_modules",
	".git",
	".lina",
	".lina-state",
	".lina-codex-state",
	".lina-sessions",
	"dist",
	"__pycache__",
]);

/** Local release installation never copies the source checkout's runtime state. */
export async function installRelease(input: InstallInput) {
	const source = checkedDirectory(input.source, false);
	const destination = resolve(input.home);
	if (destination === source || destination.startsWith(source + sep))
		throw Error("Installation home must be outside the source tree");
	const home = checkedDirectory(input.home, true);
	const runtime = checkedDirectory(join(home, "runtime"), true);
	const lock = acquireInstallationLock(runtime);
	let staging: string | undefined;
	try {
		const releases = checkedDirectory(join(runtime, "releases"), true);
		staging = checkedDirectory(
			join(releases, `.install-${randomUUID()}`),
			true,
		);
		const files: string[] = [];
		const walk = (relative: string) => {
			const path = join(source, relative),
				stat = lstatSync(path);
			if (
				/\.sqlite(?:-(?:wal|shm|journal))?$/.test(path) ||
				/(?:^|[\\/])(?:binding\.json|task-runtime\.json|codex-home|task-engine)(?:[\\/]|$)/.test(
					relative,
				)
			)
				throw Error(
					"Runtime state found in release source; choose a clean source checkout",
				);
			if (stat.isSymbolicLink())
				throw Error("Release source contains a symlink");
			if (stat.isDirectory()) {
				for (const name of readdirSync(path).sort()) {
					if (
						ignored.has(name) ||
						name.startsWith(".env") ||
						name.endsWith(".log")
					)
						continue;
					walk(join(relative, name));
				}
			} else if (stat.isFile() && stat.nlink === 1) files.push(relative);
			else throw Error("Release source contains a special or hardlinked file");
		};
		for (const entry of [
			"package.json",
			"bun.lock",
			"LICENSE",
			"NOTICE",
			"THIRD_PARTY_NOTICES.md",
		])
			walk(entry);
		for (const name of readdirSync(join(source, "packages")).sort()) {
			const packageRoot = join("packages", name);
			checkedDirectory(join(source, packageRoot), false);
			walk(join(packageRoot, "package.json"));
			for (const entry of ["src", "scripts", "client"]) {
				if (existsSync(join(source, packageRoot, entry)))
					walk(join(packageRoot, entry));
			}
		}
		for (const entry of [
			"data/app-system-prompt.md",
			"data/system-prompt.md",
			"data/personas",
		]) {
			if (existsSync(join(source, entry))) walk(entry);
		}
		const hash = createHash("sha256");
		for (const relative of files.sort()) {
			const bytes = readRegular(join(source, relative), 64 * 1024 * 1024);
			hash
				.update(relative)
				.update("\0")
				.update(String(bytes.length))
				.update("\0")
				.update(bytes);
			const target = join(staging, relative);
			checkedDirectory(dirname(target), true);
			writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
		}
		const release = hash.digest("hex");
		const target = join(releases, release);
		await (input.prepare ?? prepareDependencies)(staging);
		if (!existsSync(join(staging, "packages/lina-runtime/scripts/lina.ts")))
			throw Error("Release CLI is missing");
		if (existsSync(target))
			throw Error(
				"This release is already installed; the current installation is unchanged",
			);
		renameSync(staging, target);
		// The pointer is replaced only after the entire candidate release is ready.
		const launcher = join(runtime, "launch.ts");
		const script = `import { readFileSync } from "node:fs";\nconst value = JSON.parse(readFileSync(new URL("./current.json", import.meta.url), "utf8"));\nif (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.release)) throw Error("Invalid installed release");\nawait import(new URL("./releases/" + value.release + "/packages/lina-runtime/scripts/lina.ts", import.meta.url).href);\n`;
		const temporary = join(runtime, `.launcher-${randomUUID()}.ts`);
		writeFileSync(temporary, script, { mode: 0o600, flag: "wx" });
		checkedRegular(launcher, false);
		renameSync(temporary, launcher);
		atomicJson(join(runtime, "current.json"), { version: 1, release });
		return { home, release, path: resolve(target), command: `bun ${launcher}` };
	} finally {
		try {
			if (staging) rmSync(staging, { recursive: true, force: true });
		} finally {
			lock.close();
		}
	}
}

async function prepareDependencies(path: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			"install",
			"--frozen-lockfile",
			"--production",
			"--ignore-scripts",
		],
		{ cwd: path, stdout: "inherit", stderr: "inherit" },
	);
	if ((await child.exited) !== 0)
		throw Error(
			"Release dependency installation failed; current release was preserved",
		);
}
