import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireSessionLease,
	acquireTranscriptLease,
} from "../../lina-core/src/index.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import {
	createWorldAuthorSession,
	type WorldAuthorSession,
} from "../src/life/author-session.ts";
import { testSessionEngine } from "./fake-session-engine.ts";

function contains(error: unknown, expected: Error): boolean {
	return (
		error === expected ||
		(error instanceof AggregateError &&
			error.errors.some((item) => contains(item, expected)))
	);
}

test.each(["shutdown", "revoke"] as const)(
	"%s retains a late author's failed cleanup and retries database disposal without reopening",
	async (operation) => {
		const root = mkdtempSync(join(tmpdir(), "lina-author-open-owner-"));
		const created = Promise.withResolvers<WorldAuthorSession>();
		const release = Promise.withResolvers<void>();
		const failure = Error("One-time author journal close failure");
		let factoryCalls = 0;
		let nativeCloses = 0;
		let journalCloses = 0;
		const fleet = new AgentFleet({
			workspace: process.cwd(),
			stateRoot: root,
			agentDir: join(root, "ordinary"),
			systemPrompt: "unused",
			ownsInstallation: () => true,
			createApp: async () => {
				throw Error("Ordinary sessions forbidden");
			},
			createWorldAuthor: async (input) => {
				factoryCalls++;
				const workspace = join(input.stateRoot, "native", "workspace");
				mkdirSync(workspace, { recursive: true });
				const engine = testSessionEngine();
				const create = engine.create.bind(engine);
				engine.create = async (options) => {
					const native = await create(options);
					native.close = async () => {
						nativeCloses++;
					};
					return native;
				};
				const author = await createWorldAuthorSession({
					...input,
					workspace,
					engine,
					capabilityPolicyDigest: "a".repeat(64),
				});
				const close = author.runtime.store.close.bind(author.runtime.store);
				author.runtime.store.close = () => {
					if (++journalCloses === 1) throw failure;
					close();
				};
				created.resolve(author);
				await release.promise;
				return author;
			},
		});
		const service = fleet.life;
		service.create({ worldId: "test-world", authoredText: "Original source" });
		const grant = fleet.grantWorldAuthor("test-world", "lina");
		const opening = fleet.openWorldAuthor(grant.id).then(
			() => null,
			(error) => error as unknown,
		);
		const author = await created.promise;
		const sessionLease = () =>
			acquireSessionLease(
				join(root, "life", "author-sessions", grant.id),
				grant.agentId,
				author.binding.workspace,
			);
		const transcriptLease = () =>
			acquireTranscriptLease(
				author.binding.sessionFile,
				grant.agentId,
				author.binding.workspace,
			);
		const stop = () =>
			operation === "shutdown"
				? fleet.close()
				: fleet.revokeWorldAuthor(grant.id, grant.revision);
		try {
			expect(fleet.openedWorldAuthor(grant.id)).toBeUndefined();
			const stopping = stop().then(
				() => null,
				(error) => error as unknown,
			);
			if (operation === "revoke")
				expect(service.store.worldAuthorGrant(grant.id).status).toBe("revoked");
			release.resolve();
			const [openError, stopError] = await Promise.all([opening, stopping]);
			expect(contains(openError, failure)).toBe(true);
			expect(contains(stopError, failure)).toBe(true);
			expect(author.stopped).toBe(false);
			expect(journalCloses).toBe(1);
			expect(nativeCloses).toBe(1);
			expect(() => sessionLease()).toThrow();
			expect(() => transcriptLease()).toThrow();
			expect(author.runtime.store.history().messages).toEqual([]);
			expect(
				service.store.worldDrafts({ afterId: null, limit: 1 }).items,
			).toHaveLength(1);
			// A later call must reach the retained owner, not retry the factory/open promise.
			await stop();
			expect(author.stopped).toBe(true);
			expect(journalCloses).toBe(2);
			expect(nativeCloses).toBe(1);
			expect(factoryCalls).toBe(1);
			sessionLease().close();
			transcriptLease().close();
			await fleet.close();
		} finally {
			release.resolve();
			await opening;
			await author.stop();
			await fleet.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
