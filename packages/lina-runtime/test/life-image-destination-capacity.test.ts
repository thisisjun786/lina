import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { hash } from "../../lina-core/src/attachments/validation.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { AvatarAssets } from "../src/fleet/avatar-assets.ts";
import { lifeAvatarReservationId } from "../src/images/life-authority.ts";
import { LifeImageDestinations } from "../src/images/life-destinations.ts";
import { lifeImagePorts } from "../src/images/life-ports.ts";
import { png } from "./ima2-client-fixture.ts";
import { finalAuthorityFixture } from "./life-image-final-authority-fixture.ts";

test.each(["revoke", "pin", "stale"] as const)(
	"unused avatar destination reservation releases on %s and reapplies the original job after restore",
	async (withhold) => {
		const f = finalAuthorityFixture();
		try {
			await f.jobs.startPrepared(f.job.id, f.authority);
			const ports = lifeImagePorts({
				...f.services,
				root: dirname(f.path),
				owner: f.intent.owner,
				assertLease: () => {},
				resolveReference: () => {
					throw Error("No reference");
				},
				onComplete: () => {},
			});
			const queued = f.store.update(f.job.id, { resultFilename: "result.png" });
			const artifact = await ports.artifacts.importOutput(queued, {
				bytes: png,
				mime: "image/png",
			});
			const job = f.store.update(f.job.id, { state: "completed", artifact });
			ports.changed(job);
			const reservationId = lifeAvatarReservationId(
				"test-world",
				f.attempt.attemptId,
			);
			const owner = {
				kind: "generated" as const,
				agentId: "lina",
				worldId: "test-world",
				intentId: f.intent.intentId,
				attemptId: f.attempt.attemptId,
			};
			expect(f.agents.avatarCapacityReservation(reservationId)?.state).toBe(
				"reserved",
			);
			const filesBefore = f.agents.avatarCapacity().files;
			if (withhold === "revoke")
				f.agents.putVisualGrant("lina", f.agents.visual("lina").revision, {
					...f.grant,
					revision: 2,
					revoked: true,
				});
			else if (withhold === "pin") {
				const {
					version: _version,
					agentId: _id,
					revision,
					profileRevision: _profile,
					avatarPolicyRevision: _policy,
					pinned: _pin,
					...visual
				} = f.agents.visual("lina");
				if (!visual.avatarPolicy) throw Error("Missing avatar policy");
				f.agents.updateVisual("lina", revision, {
					...visual,
					avatarPolicy: { ...visual.avatarPolicy, whilePinned: "skip" },
				});
				f.agents.setAvatarPinned("lina", {
					requestKey: "pin-before-copy",
					expectedRevision: f.agents.visual("lina").revision,
					pinned: true,
				});
			} else {
				const profile = f.agents.get("lina");
				if (!profile) throw Error("Missing agent");
				f.agents.update("lina", profile.revision, {
					appearance: "User edited appearance",
				});
			}
			const root = dirname(f.path);
			let destination: LifeImageDestinations;
			const assets = new AvatarAssets(root, f.agents, (authority) =>
				destination.allowed(authority.candidate),
			);
			destination = new LifeImageDestinations({
				...f.services,
				root,
				avatars: assets,
				read: () => f.store.get(job.id),
			});
			expect(() =>
				destination.avatar(
					job,
					withhold === "revoke" ? "candidate" : "automatic",
				),
			).toThrow(/permitted|purpose|pinned|conflict|stale/);
			expect(f.agents.avatarCapacity().files).toBe(filesBefore);
			expect(f.agents.avatarCapacityReservation(reservationId)?.state).toBe(
				"released",
			);
			expect(f.agents.avatarCapacityReservation(reservationId)?.owner).toEqual(
				owner,
			);
			expect(f.services.world.imageUsage("test-world").count.consumed).toBe(1);
			expect(
				f.services.world.imageUsage("test-world").storage.outputBytes,
			).toBe(png.length);
			expect(
				f.services.world.imageAttempt("test-world", f.attempt.attemptId)
					?.observation?.artifact?.sha256,
			).toBe(artifact.sha256);
			f.agents.close();
			f.services.world.close();
			const world = new WorldStore(f.path, f.clock);
			const agents = new AgentStore(join(root, "agents.sqlite"));
			try {
				expect(agents.avatarCapacityReservation(reservationId)?.state).toBe(
					"released",
				);
				expect(world.imageUsage("test-world").count.consumed).toBe(1);
				if (withhold === "revoke")
					agents.putVisualGrant("lina", agents.visual("lina").revision, {
						...f.grant,
						revision: 3,
						revoked: false,
					});
				else if (withhold === "pin")
					agents.setAvatarPinned("lina", {
						requestKey: "unpin-after-reopen",
						expectedRevision: agents.visual("lina").revision,
						pinned: false,
					});
				let restored: LifeImageDestinations;
				const restoredAssets = new AvatarAssets(root, agents, (authority) =>
					restored.allowed(authority.candidate),
				);
				restored = new LifeImageDestinations({
					world,
					agents,
					assertWorkCurrent: () => {},
					root,
					avatars: restoredAssets,
					read: () => f.store.get(job.id),
				});
				const profile = agents.get("lina");
				if (!profile) throw Error("Missing agent");
				const apply = {
					requestKey: "owner-apply",
					candidateId: `avatar-candidate-${lifeDigest({
						worldId: "test-world",
						attemptId: f.attempt.attemptId,
					})}`,
					expectedProfileRevision: profile.revision,
					expectedVisualRevision: agents.visual("lina").revision,
					mode: "manual" as const,
				};
				expect(() =>
					restored.avatar(job, "candidate", {
						...apply,
						candidateId: "foreign-candidate",
					}),
				).toThrow(/candidate/);
				expect(agents.avatarHistory("lina")).toHaveLength(0);
				if (withhold === "revoke") {
					const { revision: _revision, ...other } = profile;
					agents.create({ ...other, id: "other" });
					for (let index = 0; index < 128; index++)
						agents.reserveAvatarCapacity({
							reservationId: `competing-${index}`,
							owner: {
								kind: "manual",
								agentId: "other",
								requestKey: `upload-${index}`,
							},
							maxBytes: 1,
						});
					expect(() => restored.avatar(job, "candidate", apply)).toThrow(
						"avatar capacity reached",
					);
					expect(agents.avatarCapacityReservation(reservationId)?.state).toBe(
						"released",
					);
					expect(agents.avatarHistory("lina")).toHaveLength(0);
					agents.releaseAvatarCapacity("competing-0");
				}
				const applied = restored.avatar(job, "candidate", apply);
				expect(applied.status).toBe("applied");
				expect(agents.get("lina")?.avatarId).toBe(hash(png));
				if (withhold === "stale")
					expect(agents.get("lina")?.appearance).toBe("User edited appearance");
				expect(agents.avatarCapacityReservation(reservationId)?.state).toBe(
					"settled",
				);
				expect(agents.avatarCapacityReservation(reservationId)?.owner).toEqual(
					owner,
				);
				expect(f.posts()).toBe(1);
				expect(world.imageUsage("test-world").count.consumed).toBe(1);
			} finally {
				agents.close();
				world.close();
			}
		} finally {
			await f.close();
		}
	},
);
