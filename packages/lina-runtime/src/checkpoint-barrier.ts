import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	checkedDirectory,
	readRegular,
} from "../../lina-core/src/attachments/filesystem.ts";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import {
	acquireSessionLease,
	acquireTranscriptLease,
	validateBinding,
} from "../../lina-core/src/session-binding.ts";

/** The installation lock fences tasks.sqlite and owned task homes too.
 * Also fences pre-installation-lock runtimes using their actual bound owners. */
export function acquireCheckpointBarrier(stateRoot: string): { close(): void } {
	const leases: { close(): void }[] = [acquireInstallationLock(stateRoot)];
	const close = () => {
		for (const lease of leases.splice(0).reverse()) lease.close();
	};
	try {
		const roots = [stateRoot];
		const agents = join(stateRoot, "agents");
		if (existsSync(agents)) {
			checkedDirectory(agents, false);
			for (const entry of readdirSync(agents, { withFileTypes: true })) {
				if (!entry.isDirectory() || entry.isSymbolicLink())
					throw Error("Unsafe agent state directory");
				roots.push(join(agents, entry.name));
			}
		}
		for (const root of roots) {
			const file = join(root, "binding.json");
			if (!existsSync(file)) {
				if (existsSync(join(root, "owner.sqlite")))
					throw Error(
						"Unbound session state requires recovery before checkpoint",
					);
				continue;
			}
			const binding = validateBinding(
				JSON.parse(new TextDecoder().decode(readRegular(file))),
			);
			leases.push(acquireSessionLease(root, binding.botId, binding.workspace));
			leases.push(
				acquireTranscriptLease(
					binding.sessionFile,
					binding.botId,
					binding.workspace,
				),
			);
		}
		return { close };
	} catch (error) {
		close();
		throw error;
	}
}
