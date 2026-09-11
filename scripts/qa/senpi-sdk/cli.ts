import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runCrash } from "./crash.ts";
import manifest from "./package.json" with { type: "json" };
import { runRecovery } from "./recovery.ts";
import { runFlow } from "./run.ts";

const scenarios = [
	"flow",
	"correction",
	"recovery",
	"crash-fenced",
	"crash-unfenced",
] as const;
const { values } = parseArgs({
	options: {
		root: { type: "string" },
		scenario: { type: "string", default: "all" },
	},
	strict: true,
});
const selected = z.enum(["all", ...scenarios]).parse(values.scenario);
if (values.root && !isAbsolute(values.root))
	throw new Error("Evidence root must be absolute");
const requested =
	values.root ?? join(await mkdtemp(join(tmpdir(), "senpi-sdk-")), "evidence");
const root = join(await realpath(dirname(requested)), basename(requested));
const packageRoot = resolve(
	import.meta.dir,
	import.meta.path.endsWith(".js") ? ".." : ".",
);
const checkout = await realpath(resolve(packageRoot, "../../.."));
const inside = relative(checkout, root);
if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
	throw new Error("Evidence root must be outside the checkout");
const sdk = z
	.object({
		name: z.literal("@code-yeongyu/senpi"),
		version: z.literal(manifest.dependencies["@code-yeongyu/senpi"]),
	})
	.parse(
		JSON.parse(
			await readFile(
				new URL("../package.json", import.meta.resolve("@code-yeongyu/senpi")),
				"utf8",
			),
		),
	);
await mkdir(root);
const runs = [];
for (const scenario of selected === "all" ? scenarios : [selected]) {
	switch (scenario) {
		case "flow":
		case "correction":
			runs.push(await runFlow(join(root, scenario), scenario === "correction"));
			break;
		case "recovery":
			runs.push(await runRecovery(join(root, scenario)));
			break;
		case "crash-fenced":
		case "crash-unfenced":
			runs.push(
				await runCrash(join(root, scenario), scenario === "crash-fenced"),
			);
			break;
	}
}
const report = {
	sdk: sdk.name,
	version: sdk.version,
	api: "openai-completions",
	provider: "qa-loopback",
	model: "fixture-model",
	synthetic: true,
	root,
	runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
	runs,
};
await writeFile(
	join(root, "report.json"),
	`${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
