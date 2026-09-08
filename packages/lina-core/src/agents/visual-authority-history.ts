import { isDeepStrictEqual } from "node:util";
import { boundedId } from "./validation.ts";
import type { AvatarAuthority } from "./visual.ts";
import { exact, hash, integer, parseAvatarAsset } from "./visual-validation.ts";

/** Historical ownership is independent of whether an ancestor is currently revoked. */
export function assertManualAvatarAncestry(
	authority: AvatarAuthority,
	resolve: (id: string) => AvatarAuthority | undefined,
): void {
	if (authority.kind === "generated")
		throw Error("invalid manual avatar ancestry kind");
	const asset = parseAvatarAsset(authority.asset),
		agentId = authority.agentId,
		seen = new Set<string>();
	let current: AvatarAuthority | undefined = authority;
	while (current) {
		if (
			current.kind === "generated" ||
			current.agentId !== agentId ||
			current.sha256 !== asset.sha256 ||
			!isDeepStrictEqual(parseAvatarAsset(current.asset), asset) ||
			seen.has(current.id)
		)
			throw Error("invalid manual avatar ancestry");
		boundedId(current.id, "authority");
		hash(current.sha256);
		if (current.version !== 1)
			throw Error("invalid manual avatar ancestry version");
		seen.add(current.id);
		if (current.kind === "legacy") {
			exact(current, "version,id,agentId,sha256,kind,source,asset");
			if (current.source.kind === "profile") {
				exact(current.source, "kind,profileRevision");
				integer(current.source.profileRevision, 1);
			} else {
				exact(current.source, "kind,sourceId");
				if (current.source.kind !== "seed")
					throw Error("invalid manual avatar ancestry source");
				boundedId(current.source.sourceId, "seed source");
			}
			return;
		}
		exact(current, "version,id,agentId,sha256,kind,requestKey,source,asset");
		if (current.source.kind === "upload") {
			exact(current.source, "kind");
			return;
		}
		exact(current.source, "kind,authorityId");
		if (current.source.kind !== "restore")
			throw Error("invalid manual avatar ancestry source");
		current = resolve(
			boundedId(current.source.authorityId, "parent authority"),
		);
	}
	throw Error("missing manual avatar ancestry authority");
}
