import { fileURLToPath } from "node:url";
import { resolveLinaPaths } from "../packages/lina-core/src/installation/paths.ts";
import { installRelease } from "../packages/lina-runtime/src/install-release.ts";

if (process.argv.slice(2).length)
	throw Error(
		"Set LINA_HOME to choose the destination; no arguments are accepted",
	);
const paths = resolveLinaPaths();
console.log(
	JSON.stringify(
		await installRelease({
			source: fileURLToPath(new URL("../", import.meta.url)),
			home: paths.home,
		}),
		null,
		2,
	),
);
