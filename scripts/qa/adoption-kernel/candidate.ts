import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
export function candidateDigests(): {
	sourceHash: string;
	generatorHash: string;
	rubricHash: string;
} {
	const root = import.meta.dir;
	const source = createHash("sha256");
	for (const name of readdirSync(root)
		.filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
		.sort())
		source.update(name).update(readFileSync(join(root, name)));
	const rubric = createHash("sha256");
	for (const name of ["001_rubric.md", "005_scoring_contract.md"])
		rubric
			.update(name)
			.update(
				readFileSync(
					resolve(
						root,
						"../../../docs/plans/agent-experience/independent",
						name,
					),
				),
			);
	return {
		sourceHash: source.digest("hex"),
		generatorHash: createHash("sha256")
			.update(readFileSync(join(root, "scenarios.ts")))
			.digest("hex"),
		rubricHash: rubric.digest("hex"),
	};
}
