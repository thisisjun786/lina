import { randomBytes } from "node:crypto";
import type { IdentityPolicySnapshot } from "../../../../lina-core/src/world/life-types.ts";
import type {
	SocialPrepareRequest,
	WorldSocialPort,
} from "../../../../lina-core/src/world/social-store-types.ts";
import type { SocialEnginePort } from "./port.ts";

/** Internal manual driver for 030; the later runner owns scheduling and narration. */
export function createSocialService(options: {
	store: WorldSocialPort;
	engine: SocialEnginePort;
	identity(worldId: string): IdentityPolicySnapshot;
	entropy?: () => number;
}) {
	const entropy = options.entropy ?? (() => randomBytes(4).readUInt32BE());
	return {
		async resolve(
			request: Omit<SocialPrepareRequest, "identity">,
			signal: AbortSignal,
		) {
			signal.throwIfAborted();
			const prepared = options.store.prepareSocialResolution(
				{ ...request, identity: options.identity(request.worldId) },
				entropy,
			);
			if (prepared.result !== null) return prepared;
			if ("kind" in prepared.input)
				throw Error("Incomplete social extension receipt");
			const result = await options.engine.resolve(prepared.input, signal);
			signal.throwIfAborted();
			return options.store.finishSocialResolution(
				request.worldId,
				request.requestId,
				result,
			);
		},
		accept(worldId: string, requestId: string) {
			return options.store.acceptSocialResolution(
				worldId,
				requestId,
				options.identity(worldId),
			);
		},
	};
}
