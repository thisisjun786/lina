# Third-party notices

Lina's original work uses [Apache-2.0](LICENSE); dependencies and external
projects retain their own copyrights and licenses. This file records the scoped
OpenViking, Honcho, and lossless-claw review inherited from the runtime adapter
work. The pinned declarations below were rechecked on 2026-09-07. All evidence
links are self-contained; no private or missing audit document is required.

This is not a complete dependency inventory, source-ancestry audit, or notice
bundle for a released installer/container. Package versions come from `bun.lock`
and the package manifests; each dependency's distributed license remains
authoritative. A dependency installed or bundled into an artifact can require
its own license and notices even when it is not vendored in Lina's Git tree.
Preserve those texts with any distributed copies and review the actual artifact.

## OpenViking

- Reviewed pin: `420d4074f74070bc6fe7151aa54527cf1ff15152`.
- Main project/server: GNU Affero General Public License v3.0, per the pinned
  [LICENSE](https://github.com/volcengine/OpenViking/blob/420d4074f74070bc6fe7151aa54527cf1ff15152/LICENSE).
- `crates/ov_cli` and `examples`: Apache-2.0, as identified by the pinned
  [README](https://github.com/volcengine/OpenViking/blob/420d4074f74070bc6fe7151aa54527cf1ff15152/README.md),
  [crates license](https://github.com/volcengine/OpenViking/blob/420d4074f74070bc6fe7151aa54527cf1ff15152/crates/LICENSE),
  and [examples license](https://github.com/volcengine/OpenViking/blob/420d4074f74070bc6fe7151aa54527cf1ff15152/examples/LICENSE).
  Upstream `third_party` components retain their respective licenses.
- Lina integration: the original adapter review records independently written
  HTTP code in `packages/lina-memory/src/openviking`, with no server source
  imported by that change. Connecting to a separately operated server does not
  relicense the server or grant redistribution rights beyond its own terms.

## Honcho

- Reviewed pin: `be54355545b64ddb10203829d323861f52423685`.
- Server: GNU Affero General Public License v3.0, per the pinned
  [LICENSE](https://github.com/plastic-labs/honcho/blob/be54355545b64ddb10203829d323861f52423685/LICENSE).
- TypeScript SDK `@honcho-ai/sdk` 2.4.0 declares Apache-2.0 in its pinned
  [package.json](https://github.com/plastic-labs/honcho/blob/be54355545b64ddb10203829d323861f52423685/sdks/typescript/package.json).
  Python SDK `honcho-ai` 2.4.0 declares Apache-2.0 in its pinned
  [pyproject.toml](https://github.com/plastic-labs/honcho/blob/be54355545b64ddb10203829d323861f52423685/sdks/python/pyproject.toml).
  These are SDK metadata declarations, separate from the server's license;
  inspect the actual SDK distribution before redistributing it.
- A bounded review on 2026-09-07 covered 11 Honcho files and four SDK files
  against the pinned upstream. It found no material copied code block or removed
  notices. This is not a complete ancestry certification.

## lossless-claw (LCM plugin)

- Reviewed pin: `c6d06e528867004c85ae84897019d94f0cdbea50`.
- MIT; Copyright (c) 2026 Josh Lehman / Martian Engineering, per the pinned
  [LICENSE](https://github.com/Martian-Engineering/lossless-claw/blob/c6d06e528867004c85ae84897019d94f0cdbea50/LICENSE).
- A bounded review on 2026-09-07 compared Lina's LCM tree, summarize, and store
  code with the pinned upstream and found no material copied code block or
  removed notices. The reviewed Lina implementation adopts the memory-management
  pattern; it is not a plugin port. This is not a complete ancestry certification;
  preserve upstream copyright and license if code is copied later.

## Distribution and remaining provenance review

Before copying, modifying, distributing, or operating a modified covered server,
review its pinned license, including AGPL sections 4–6 and 13 where applicable.
An HTTP integration review is not a source-offer or redistribution audit of a
server/container. No external service is relicensed by Lina's Apache-2.0 choice.

Maintainer-authored persona text and the owner's 2026-09-07 attestation for nine
avatars and two app icons are documented in
[data/personas/README.md](data/personas/README.md). The owner confirmed directly
creating/generating those images and holding their input rights, and grants
Apache-2.0 to the extent of the rights held. That statement covers the identified
assets; it does not relicense external software or imply rights in other images.
[The publication checklist](docs/PUBLICATION.md) tracks artifact notices, source
privacy review, and the separate activation steps.
