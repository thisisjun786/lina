import type { GeneratedAvatarCandidate } from "../../../lina-core/src/agents/visual.ts";
import type {
	PublicationPrincipal,
	PublicLifeImage,
} from "../../../lina-core/src/world/publication-types.ts";
import type { ImageJob } from "../images/contracts.ts";
import type { ImageClient } from "../images/jobs.ts";
import { LifeImages } from "../images/life.ts";
import { LifeImageDestinations } from "../images/life-destinations.ts";
import { LifeImageDiscovery } from "../images/life-discovery.ts";
import type { LifeImageAuthorityServices } from "../images/life-permissions.ts";
import { LifeImagePosts } from "../images/life-posts.ts";
import { visitLifeImages } from "../images/life-scheduler.ts";
import type { LifeForeground } from "../life/runner.ts";
import type { LifeClock } from "../life/scheduler.ts";
import { AvatarAssets } from "./avatar-assets.ts";

interface Options extends LifeImageAuthorityServices {
	root: string;
	clock: LifeClock;
	foreground: LifeForeground;
	assertInstallation(): void;
	createClient(): ImageClient;
	changed(): void;
}

/** Lazy manifests/clients, shared scheduler and independent generation/destination receipts. */
export class FleetLifeImages {
	readonly avatars: AvatarAssets;
	readonly discovery: LifeImageDiscovery;
	readonly destinations: LifeImageDestinations;
	readonly posts: LifeImagePosts;
	private readonly images: LifeImages;
	private readonly stop = new AbortController();
	private readonly active = new Set<Promise<unknown>>();
	private readonly errors = new Map<string, "image_unavailable">();
	private foregroundAbort = new AbortController();
	private readonly unsubscribe: () => void;
	constructor(private readonly options: Options) {
		this.avatars = new AvatarAssets(options.root, options.agents, (authority) =>
			this.allowed(authority.candidate),
		);
		this.discovery = new LifeImageDiscovery(options.world, options.agents);
		this.images = new LifeImages({
			...options,
			foreground: () => options.foreground.active(),
			resolveReference: (reference) => this.avatars.resolveReference(reference),
			syncAvatarInventory: () => this.avatars.syncInventory(),
			// Completion records an image fact. Destination policy is evaluated separately below.
			onComplete: () => options.changed(),
		});
		const destinationOptions = {
			...options,
			avatars: this.avatars,
			read: (worldId: string, attemptId: string) =>
				this.images.read(worldId, attemptId),
		};
		this.destinations = new LifeImageDestinations(destinationOptions);
		this.posts = new LifeImagePosts(destinationOptions);
		this.unsubscribe = options.foreground.subscribe(() => {
			if (options.foreground.active()) this.foregroundAbort.abort();
			else this.foregroundAbort = new AbortController();
		});
	}
	read(worldId: string, attemptId: string) {
		return this.images.read(worldId, attemptId);
	}
	now() {
		return this.options.clock.now();
	}
	allowed(candidate: GeneratedAvatarCandidate) {
		return this.destinations.allowed(candidate);
	}
	/** Resolve only the visible request page before the final feed transaction. */
	feedImages(
		worldId: string,
		principal: PublicationPrincipal,
		recipientId: string,
		postIds: readonly string[],
	): ReadonlyMap<string, PublicLifeImage> {
		const { world } = this.options;
		const result = new Map<string, PublicLifeImage>();
		if (!postIds.length) return result;
		const attempts = world.imageAttempts(worldId);
		for (const postId of new Set(postIds)) {
			if (!world.publicationPost(worldId, principal, postId)) continue;
			if (
				!attempts.some(
					(attempt) =>
						attempt.delivery.kind === "post" &&
						attempt.delivery.postId === postId,
				)
			)
				continue;
			const asset = this.posts.asset(worldId, postId, recipientId, attempts);
			if (!asset) continue;
			const metadata = world.imagePostAsset(worldId, postId, recipientId);
			if (!metadata) continue;
			result.set(postId, {
				artifactId: metadata.artifactId,
				attachmentVersion: metadata.attachmentVersion,
				mime: metadata.mime,
				size: metadata.size,
				altText: metadata.altText,
				url: `/api/life/worlds/${worldId}/feed/posts/${postId}/assets/${metadata.artifactId}`,
			});
		}
		return result;
	}
	private complete(job: ImageJob, invocation: "manual" | "scheduled") {
		if (
			job.origin.kind !== "life" ||
			job.owner.kind !== "life" ||
			job.state !== "completed"
		)
			return;
		const { world } = this.options;
		const intent = world.imageIntent(job.owner.worldId, job.origin.intentId);
		if (!intent) throw Error("Missing image destination intent");
		const config = world.lifeConfig(job.owner.worldId);
		if (
			this.stop.signal.aborted ||
			this.options.foreground.active() ||
			(invocation === "scheduled" &&
				((!config.run && intent.source.kind !== "avatar_wall") ||
					config.run?.mode === "paused"))
		) {
			this.images.withholdAvatarDestination(job);
			return;
		}
		try {
			if (intent.source.kind === "event_post") {
				if (
					invocation === "scheduled" &&
					intent.requestKey === null &&
					config.images?.mode === "automatic"
				)
					this.posts.attach(job, "automatic");
			} else {
				const automatic =
					invocation === "scheduled" &&
					intent.requestKey === null &&
					config.avatars?.mode === "automatic";
				this.destinations.avatar(job, automatic ? "automatic" : "candidate");
			}
			this.errors.delete(intent.intentId);
		} catch {
			// Generation remains completed and recoverable even if permission/CAS withholds application.
			this.errors.set(intent.intentId, "image_unavailable");
		}
	}
	private track<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		this.stop.signal.throwIfAborted();
		const effective = AbortSignal.any([
			signal,
			this.stop.signal,
			this.foregroundAbort.signal,
		]);
		const running = operation(effective);
		this.active.add(running);
		return running.finally(() => this.active.delete(running));
	}
	run(
		worldId: string,
		intentId: string,
		requestKey: string,
		signal: AbortSignal,
	) {
		return this.track(async (effective) => {
			const job = await this.images.run(
				worldId,
				intentId,
				requestKey,
				"manual",
				effective,
			);
			this.complete(job, "manual");
			return job;
		}, signal);
	}
	retry(
		worldId: string,
		intentId: string,
		previousAttemptId: string,
		requestKey: string,
		signal: AbortSignal,
	) {
		return this.track(async (effective) => {
			const job = await this.images.retry(
				worldId,
				intentId,
				previousAttemptId,
				requestKey,
				effective,
			);
			this.complete(job, "manual");
			return job;
		}, signal);
	}
	reconcile(worldId: string, attemptId: string, signal: AbortSignal) {
		return this.track(async (effective) => {
			const job = await this.images.reconcile(worldId, attemptId, effective);
			this.complete(job, "manual");
			return job;
		}, signal);
	}
	visit(worldId: string, signal: AbortSignal) {
		return this.track(
			(effective) =>
				visitLifeImages(
					{
						store: this.options.world,
						images: this.images,
						discovery: this.discovery,
						clock: this.options.clock,
						foreground: () => this.options.foreground.active(),
						completed: (job) => this.complete(job, "scheduled"),
						onError: (id) => this.errors.set(id, "image_unavailable"),
					},
					worldId,
					effective,
				),
			signal,
		);
	}
	status(intentId: string) {
		return this.errors.get(intentId) ?? null;
	}
	async close() {
		this.stop.abort();
		this.unsubscribe();
		await this.images.close();
		await Promise.allSettled([...this.active]);
	}
}
