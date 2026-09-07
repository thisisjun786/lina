import { expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "secrets.sh");

test("scanner setup propagates every process failure and controls scanner inputs", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-secret-wrapper-"));
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
		const commands: Record<string, string> = {
			curl: `echo curl >> "$CI_TRACE"
if [ "$CI_FAULT" = curl ]; then exit 22; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; : > "$1"; break; fi
  shift
done`,
			sha256sum: `echo sha256sum >> "$CI_TRACE"
cat >/dev/null
if [ "$CI_FAULT" = sha256sum ]; then exit 23; fi`,
			tar: `echo tar >> "$CI_TRACE"
if [ "$CI_FAULT" = tar ]; then exit 24; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = -C ]; then shift; destination=$1; break; fi
  shift
done
cat > "$destination/gitleaks" <<'SCANNER'
#!/bin/sh
echo gitleaks >> "$CI_TRACE"
printf '%s\n' "$@" > "$CI_SCAN_ARGS"
if [ -n "\${GITLEAKS_CONFIG+x}\${GITLEAKS_CONFIG_TOML+x}" ]; then exit 26; fi
if [ "$CI_FAULT" = gitleaks ]; then exit 25; fi
SCANNER
chmod +x "$destination/gitleaks"`,
		};
		for (const [name, body] of Object.entries(commands)) {
			writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`);
			chmodSync(join(bin, name), 0o700);
		}
		const stages = ["curl", "sha256sum", "tar", "gitleaks"];
		for (const [fault, code] of [
			["curl", 22],
			["sha256sum", 23],
			["tar", 24],
			["gitleaks", 25],
			["none", 0],
		] as const) {
			const trace = join(root, `trace-${fault}`);
			const argsPath = join(root, `args-${fault}`);
			const result = Bun.spawnSync(["bash", script], {
				cwd: root,
				env: {
					...process.env,
					PATH: `${bin}:${process.env["PATH"] ?? ""}`,
					CI_FAULT: fault,
					CI_TRACE: trace,
					CI_SCAN_ARGS: argsPath,
					GITLEAKS_CONFIG: "unreviewed.toml",
					GITLEAKS_CONFIG_TOML: "unreviewed config",
				},
			});
			expect(result.exitCode).toBe(code);
			expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(
				stages.slice(0, fault === "none" ? 4 : stages.indexOf(fault) + 1),
			);
			if (fault === "gitleaks" || fault === "none") {
				const args = readFileSync(argsPath, "utf8").trim().split("\n");
				expect(args[0]).toBe("git");
				expect(args[1]).toBe(join(root, ".git"));
				expect(args).toContain("--ignore-gitleaks-allow");
				expect(args).toContain("--log-opts=--all -m");
				expect(args).toContain("--redact");
				expect(args).not.toContain("--baseline-path");
				expect(args[args.indexOf("--config") + 1]).toBe(
					join(root, ".gitleaks.toml"),
				);
				const ignored = args[args.indexOf("--gitleaks-ignore-path") + 1];
				expect(typeof ignored).toBe("string");
				expect(existsSync(ignored ?? "")).toBe(false);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
