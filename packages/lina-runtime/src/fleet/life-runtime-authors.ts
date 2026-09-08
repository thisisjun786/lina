import { join } from "node:path";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import type {
	WorldAuthorFactoryOptions,
	WorldAuthorSession,
} from "../life/author-session.ts";
import type { WorldAuthoring } from "../life/authoring.ts";
import type { ModelSettingsStore } from "../models/settings.ts";
import type { FleetLifeForeground } from "./life-runtime-state.ts";

/** Retains author ownership through open/close races and contributes foreground state. */
export class FleetLifeAuthors {
	private readonly authors = new Map<string, Promise<WorldAuthorSession>>();
	private readonly ownedAuthors = new Map<string, WorldAuthorSession>();
	private readonly readyAuthors = new Map<string, WorldAuthorSession>();
	constructor(
		private readonly context: {
			root: string;
			agents: AgentStore;
			modelSettings: ModelSettingsStore;
			foreground: FleetLifeForeground;
			service(): WorldAuthoring;
			closing(): boolean;
			create?: (
				options: WorldAuthorFactoryOptions,
			) => Promise<WorldAuthorSession>;
		},
	) {}
	open(grantId: string): Promise<WorldAuthorSession> {
		const service = this.context.service();
		const grant = service.store.worldAuthorGrant(grantId);
		const scope = { grantId, grantRevision: grant.revision };
		service.assertScope(scope);
		const profile = this.context.agents.get(grant.agentId);
		if (!profile) throw Error("Unknown guide agent");
		const existing = this.authors.get(grantId);
		if (existing) return existing;
		if (!this.context.create)
			throw Error("Qualified world author engine unavailable");
		const stateRoot = checkedDirectory(
			join(this.context.root, "life", "author-sessions", grant.id),
			true,
		);
		const pending = this.context
			.create({
				stateRoot,
				grant,
				profile,
				service,
				modelSettings: () => this.context.modelSettings.snapshot(),
			})
			.then(async (author) => {
				// The factory transferred ownership even if this open is no longer valid.
				this.ownedAuthors.set(grantId, author);
				try {
					service.assertScope(scope);
					if (this.context.closing()) throw Error("Fleet is closed");
					this.readyAuthors.set(grantId, author);
					this.context.foreground.track(author.runtime);
					return author;
				} catch (error) {
					try {
						await author.stop();
					} catch (cleanupError) {
						throw new AggregateError(
							[error, cleanupError],
							"World author open and cleanup failed",
						);
					} finally {
						this.forgetStopped(grantId, author);
					}
					throw error;
				}
			})
			.catch((error) => {
				if (!this.ownedAuthors.has(grantId)) this.authors.delete(grantId);
				throw error;
			});
		this.authors.set(grantId, pending);
		return pending;
	}
	private forgetStopped(grantId: string, author: WorldAuthorSession) {
		if (author.stopped && this.ownedAuthors.get(grantId) === author) {
			this.ownedAuthors.delete(grantId);
			this.authors.delete(grantId);
			this.readyAuthors.delete(grantId);
			this.context.foreground.forget(author.runtime);
		}
	}
	private async stop(grantId: string): Promise<boolean> {
		let author = this.ownedAuthors.get(grantId);
		if (!author) {
			try {
				await this.authors.get(grantId);
			} catch (error) {
				// Report this opening's cleanup failure without silently retrying it.
				// A later stop finds the retained owner directly, bypassing the failed open.
				if (this.ownedAuthors.has(grantId)) throw error;
				return false;
			}
			author = this.ownedAuthors.get(grantId);
		}
		if (!author) return false;
		try {
			await author.stop();
			return true;
		} finally {
			this.forgetStopped(grantId, author);
		}
	}
	opened(grantId: string) {
		const service = this.context.service();
		const grant = service.store.worldAuthorGrant(grantId);
		service.assertScope({ grantId, grantRevision: grant.revision });
		return this.readyAuthors.get(grantId);
	}
	async revoke(grantId: string, expectedRevision: number) {
		const service = this.context.service();
		// Persist revocation before signalling native work or releasing an approval.
		const grant = service.store.revokeWorldAuthor(grantId, expectedRevision);
		if (!(await this.stop(grantId))) await service.cancelGrant(grantId);
		return grant;
	}
	async close() {
		const failures: unknown[] = [];
		for (const id of new Set([
			...this.authors.keys(),
			...this.ownedAuthors.keys(),
		])) {
			try {
				await this.stop(id);
			} catch (error) {
				failures.push(error);
			}
		}
		return failures;
	}
}
