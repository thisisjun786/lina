import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { resolveLinaPaths } from "../src/installation/paths.ts";

const homeDir = "/home/tester";
const cwd = "/tmp/project-cwd";

const defaultPaths = {
	home: "/home/tester/.lina",
	stateRoot: "/home/tester/.lina/state",
	workspaceRoot: "/home/tester/.lina/workspaces",
	historyRoot: "/home/tester/.lina/history",
	runtimeRoot: "/home/tester/.lina/runtime",
	credentialsRoot: "/home/tester/.lina/credentials",
	skillsRoot: "/home/tester/.lina/skills",
	logsRoot: "/home/tester/.lina/logs",
	cacheRoot: "/home/tester/.lina/cache",
	configPath: "/home/tester/.lina/config.json",
};

describe("resolveLinaPaths", () => {
	it("defaults to homedir/.lina and does not infer home from cwd", () => {
		expect(
			resolveLinaPaths({
				env: {},
				homeDir,
				cwd,
			}),
		).toEqual(defaultPaths);
	});

	it("uses distinct LINA_HOME and LINA_STATE_DIR values", () => {
		expect(
			resolveLinaPaths({
				env: {
					LINA_HOME: "/opt/lina-home",
					LINA_STATE_DIR: "/var/lina-legacy-state",
				},
				homeDir,
				cwd,
			}),
		).toEqual({
			home: "/opt/lina-home",
			stateRoot: "/var/lina-legacy-state",
			workspaceRoot: "/opt/lina-home/workspaces",
			historyRoot: "/opt/lina-home/history",
			runtimeRoot: "/opt/lina-home/runtime",
			credentialsRoot: "/opt/lina-home/credentials",
			skillsRoot: "/opt/lina-home/skills",
			logsRoot: "/opt/lina-home/logs",
			cacheRoot: "/opt/lina-home/cache",
			configPath: "/opt/lina-home/config.json",
		});
	});

	it("expands ~/ LINA_HOME against injected homeDir", () => {
		expect(
			resolveLinaPaths({
				env: { LINA_HOME: "~/Apps/Lina" },
				homeDir,
				cwd,
			}).home,
		).toBe("/home/tester/Apps/Lina");
		expect(
			resolveLinaPaths({
				env: { LINA_HOME: "~" },
				homeDir,
				cwd,
			}).home,
		).toBe("/home/tester");
	});

	it("resolves relative LINA_STATE_DIR against cwd only", () => {
		const paths = resolveLinaPaths({
			env: { LINA_STATE_DIR: "legacy-state" },
			homeDir,
			cwd,
		});
		expect(paths.home).toBe("/home/tester/.lina");
		expect(paths.stateRoot).toBe("/tmp/project-cwd/legacy-state");
		expect(paths.workspaceRoot).toBe("/home/tester/.lina/workspaces");
	});

	it("keeps spaces in home and state paths", () => {
		expect(
			resolveLinaPaths({
				env: {
					LINA_HOME: "/mnt/Lina Data/home",
					LINA_STATE_DIR: "old state",
				},
				homeDir: "/home/user name",
				cwd: "/tmp/My Project",
			}),
		).toEqual({
			home: "/mnt/Lina Data/home",
			stateRoot: "/tmp/My Project/old state",
			workspaceRoot: "/mnt/Lina Data/home/workspaces",
			historyRoot: "/mnt/Lina Data/home/history",
			runtimeRoot: "/mnt/Lina Data/home/runtime",
			credentialsRoot: "/mnt/Lina Data/home/credentials",
			skillsRoot: "/mnt/Lina Data/home/skills",
			logsRoot: "/mnt/Lina Data/home/logs",
			cacheRoot: "/mnt/Lina Data/home/cache",
			configPath: "/mnt/Lina Data/home/config.json",
		});
	});

	it.each([
		"",
		"   ",
		".",
		"./.lina",
		"../lina",
		"relative",
		"lina-home",
		"~other/lina",
	])("rejects empty or relative LINA_HOME %j", (value) => {
		expect(() =>
			resolveLinaPaths({ env: { LINA_HOME: value }, homeDir, cwd }),
		).toThrow(/LINA_HOME/);
	});

	it.each(["", "   "])("rejects empty LINA_STATE_DIR %j", (value) => {
		expect(() =>
			resolveLinaPaths({ env: { LINA_STATE_DIR: value }, homeDir, cwd }),
		).toThrow(/LINA_STATE_DIR/);
	});

	it("does not read process.env or write the filesystem", () => {
		const key = "LINA_HOME";
		const previous = process.env[key];
		process.env[key] = "/from-process";
		const missing = "/tmp/lina-paths-resolver-absent-home";
		const env = Object.freeze({ LINA_HOME: "/opt/frozen-home" });
		try {
			expect(existsSync(missing)).toBe(false);
			const paths = resolveLinaPaths({
				env,
				homeDir: missing,
				cwd: "/tmp/lina-paths-resolver-absent-cwd",
			});
			expect(paths.home).toBe("/opt/frozen-home");
			expect(paths.stateRoot).toBe("/opt/frozen-home/state");
			expect(existsSync(missing)).toBe(false);
			expect(existsSync("/opt/frozen-home")).toBe(false);
			expect(process.env[key]).toBe("/from-process");
			expect({ ...env }).toEqual({ LINA_HOME: "/opt/frozen-home" });
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
	});

	it("resolves Windows paths through an explicit flavor", () => {
		expect(
			resolveLinaPaths({
				env: {
					LINA_HOME: "C:\\Lina Home",
					LINA_STATE_DIR: "legacy\\state",
				},
				homeDir: "C:\\Users\\Tester",
				cwd: "D:\\work",
				flavor: win32,
			}),
		).toEqual({
			home: "C:\\Lina Home",
			stateRoot: "D:\\work\\legacy\\state",
			workspaceRoot: "C:\\Lina Home\\workspaces",
			historyRoot: "C:\\Lina Home\\history",
			runtimeRoot: "C:\\Lina Home\\runtime",
			credentialsRoot: "C:\\Lina Home\\credentials",
			skillsRoot: "C:\\Lina Home\\skills",
			logsRoot: "C:\\Lina Home\\logs",
			cacheRoot: "C:\\Lina Home\\cache",
			configPath: "C:\\Lina Home\\config.json",
		});
		expect(
			resolveLinaPaths({
				env: { LINA_HOME: "~\\AppData\\Lina" },
				homeDir: "C:\\Users\\Tester",
				cwd: "D:\\work",
				flavor: win32,
			}).home,
		).toBe("C:\\Users\\Tester\\AppData\\Lina");
	});
});
