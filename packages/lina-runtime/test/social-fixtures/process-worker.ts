import { readdirSync, readFileSync } from "node:fs";

const mode = await Bun.stdin.text();
if (mode === "inspect")
	process.stdout.write(
		JSON.stringify({
			env: process.env,
			cwd: process.cwd(),
			cwdFiles: readdirSync("."),
			limits: readFileSync("/proc/self/limits", "utf8"),
		}),
	);
else if (mode.startsWith("busy-ready:")) {
	process.kill(Number(mode.split(":")[1]), "SIGUSR2");
	while (true) Math.sqrt(17);
} else if (mode === "busy") {
	while (true) Math.sqrt(17);
} else if (mode === "output") {
	process.stdout.write("x".repeat(1024 * 1024));
} else if (mode === "oom") {
	new Uint8Array(600 * 1024 * 1024).fill(1);
} else if (mode === "crash") {
	process.stdout.write('{"result":"must not accept"}');
	process.exitCode = 9;
} else throw Error("unknown fixture mode");
