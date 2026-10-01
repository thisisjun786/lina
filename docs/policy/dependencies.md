# Dependencies

This policy covers code that LINA takes from outside the repository: npm packages, the Node.js runtime, opencodex, pinned binaries, external components, and upstream source vendored into the repository. LINA Core runs all day with the user's credentials, so outside code must be pinned, reviewed like any other code, and verified in CI before it can run. The rules apply from the first change that adds a dependency, and the `foundation` check enforces them.

## Scope

This policy covers:

- npm packages in the workspace manifests and the root lockfile
- the Node.js runtime used by CI and bundled by releases
- opencodex, binaries that LINA ships or downloads, external components, CI tools, and GitHub Actions
- upstream source and generated upstream code under `vendor/`
- the `dependencies` check that enforces these rules

Tools the user installs are outside this policy: coding agents such as Codex, RUMI, the command-line tools that plugins rely on, and the plugins the user adds with their servers. They are not LINA dependencies. LINA records the version and source it observed for them and never pins them ([runtime.md](../design/runtime.md), [integrations.md](../design/integrations.md)). First-party plugins are LINA code and follow this policy.

Other documents cover what each component uses and why. [runtime.md](../design/runtime.md) names the vendored upstream, the model client, opencodex, external components, the packaging, and the release manifest. The [CI policy](ci.md) owns path mapping and job layout.

## npm packages

### Package manager and configuration

npm, which ships with the pinned Node.js runtime, is the only package manager. The root `.npmrc` contains:

```ini
registry=https://registry.npmjs.org/
save-exact=true
ignore-scripts=true
```

These settings apply to every npm command in the checkout. Do not override them with flags, environment variables, or user configuration.

Run tools from the lockfile through package scripts or `npx --no-install`. Scripts and CI never fetch an unpinned tool at run time, for example with `npx <package>` for a package outside the lockfile or with a piped install script.

### Exact versions and sources

- Every `dependencies`, `devDependencies`, and `optionalDependencies` entry in every `package.json` names one exact version, such as `1.2.3`. Ranges, dist-tags, `*`, Git URLs, tarball URLs, and `file:` specs are rejected. Workspace packages refer to each other by exact version.
- An `overrides` entry, which pins a transitive package, names one exact version.
- Packages come only from the public npm registry. Every lockfile entry resolves to `https://registry.npmjs.org/` and has a `sha512` integrity value.

### Lockfile

- One `package-lock.json` at the root covers the whole workspace. It is committed and changes only through npm, in the same PR as the manifest change that causes it.
- CI and release builds install with `npm ci --ignore-scripts`, which fails if the lockfile and manifests disagree. Use `npm install` only to change dependencies, never to verify them.
- Release artifacts are built from the same lockfile with `npm ci --ignore-scripts --omit=dev`. A release build resolves nothing new.
- Install and build jobs have no secrets or write tokens. Publication runs in a separate job that does not install packages.

### No lifecycle scripts

- Because `ignore-scripts=true`, no package runs a `preinstall`, `install`, `postinstall`, or `prepare` script, in CI or locally.
- LINA's own packages define none of these scripts and no `pre` or `post` hooks. Scripts invoked explicitly, such as `npm test` or `npm run build`, still run.
- A dependency that needs an install script to work is not admitted. Native code comes from prebuilt platform packages verified by lockfile integrity or from a pinned binary verified by digest.
- A lockfile entry with `hasInstallScript` is admitted only when the exceptions file lists that exact name and version and explains why the package works without the script. The component's tests must pass with the script never run.

### Signatures and provenance

- After `npm ci --ignore-scripts`, run `npm audit signatures`. A missing or invalid registry signature or an invalid provenance attestation fails the check.

### Adding or updating a package

- Use a Node.js built-in module when it covers the need.
- A new upstream release may be adopted as soon as it is published. No minimum release age applies to any dependency.
- Review the dependency change as code, including its license and the transitive package count that the `dependencies` check reports.
- In-process dependencies use licenses that allow distribution with LINA under MIT when their notices are kept, such as MIT, Apache-2.0, BSD, and ISC. Code under other licenses runs only as an external component ([runtime.md](../design/runtime.md)).
- Update packages in small groups that reviewers can assess together. Split bulk updates of unrelated packages. Update PRs follow these rules whether a person or a bot opens them.

## Runtime and binaries

- `.node-version` records one exact Node.js version. CI component checks use it, and every release bundles it after verifying it as described in [runtime.md](../design/runtime.md).
- opencodex is a LINA dependency: the upstream npm package `@bitkyc08/opencodex` from [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex). LINA's installation installs it at the version and digest the release pins, and the pin follows upstream releases.
- Pin every other binary that LINA ships or downloads, including sqlite-vec platform binaries, CI tools such as actionlint, and [external components](../design/runtime.md), by version and SHA-256 digest. Verify each download against its digest before extraction or execution, every time, including after a cache hit.
- An external component ships with its license and notices.
- Pin GitHub Actions by full commit SHA, with the release tag in a comment.
- The release manifest in [runtime.md](../design/runtime.md) records each pinned version and digest.

## Vendored code

LINA vendors upstream TypeScript instead of translating it, so each upstream change remains a diff that can be reviewed. [runtime.md](../design/runtime.md) names what LINA vendors. Each vendored upstream has its own directory:

```text
vendor/<name>/
  upstream/      upstream files at their upstream relative paths, unchanged, with their tests, license, and notices
  patches/       recorded patches, applied in order; present only when a patch is unavoidable
  vendor.json    source, scope, file hashes, and patch records
  package.json   LINA's workspace wrapper: exact dev dependencies the upstream tests need, and the test script
```

- **Unchanged:** every file under `upstream/` is byte-identical to the recorded upstream commit, or to the result of applying the recorded patches. Vendored tests come with the code they test and run unchanged in CI.
- **Licenses and notices:** keep the upstream license and notice files in `upstream/`. [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) has one entry per vendored tree with the source repository, commit, scope, license, and one line for each patch.
- **Wrapping layers:** LINA changes, including adapters, a different model client, extra checks, and extra behavior, live in LINA's own packages that import vendored code. LINA never edits files under `upstream/`, and vendored code never imports LINA packages.
- **Patches:** use a patch only when a wrapping layer cannot make the change. Examples are an unreleased upstream security fix and removing an import that would bring in a rejected dependency. Record each patch as a file in `patches/` and an entry in `vendor.json` with its id, the files it touches, its reason, why a wrapper cannot make the change, and the upstream issue or PR when one exists. Offer a general fix upstream, and delete the patch once upstream includes it.
- **Scope:** `vendor.json` lists the upstream paths that LINA includes: the import closure of the code LINA uses and its tests. An excluded file is outside the scope, not a patch.
- **Generated upstream code:** code generated by an upstream tool, such as the Codex app-server TypeScript types from `codex app-server generate-ts --experimental` for each verified Codex version, is vendored the same way. Instead of a commit, `vendor.json` records the tool, the version and digest it ran at, and the exact command. Never edit generated code by hand. A sync regenerates it.

`vendor.json` records the name, source repository URL, upstream commit (40 hex characters) and release tag when one exists, license, scope, SHA-256 hash of each file as upstream ships it and as it sits in the tree, and patch records.

The LINA kit is never published to the npm registry. A sibling repository that uses it vendors it from one LINA release tag under these same rules, with the release tag as its upstream reference ([runtime.md](../design/runtime.md)).

### Upstream sync

A sync updates one vendored tree in one PR, such as `chore(vendor): sync <name> to <tag>`:

1. Choose an upstream release. For an upstream without releases, choose a default-branch commit.
2. Review upstream changes in the scope between the recorded and target commits, including the changelog, breaking changes, new imports, and license changes.
3. Overwrite `upstream/` with the target commit's files for the scope. Change the scope only to follow the import closure, and state the change.
4. Re-apply the recorded patches in order. Delete a patch that upstream makes unnecessary. Rewrite a patch that fails to apply, and keep its reason current. Record a new patch in full.
5. Update `vendor.json`, the notices entry, and any wrapping layer affected by the upstream change.
6. Run the vendored tests unchanged, the wrapping layers' tests, and the checks of every dependent component.
7. List the upstream range, scope changes, kept, rewritten, and dropped patches, test results, and any behavior change at the wrapper boundary in the PR body.

Another change never updates vendored code as a side effect.

## Exceptions

`.github/dependency-exceptions.json` is the only place where a rule in this policy can be waived. Each entry names its kind (`install-script`), the exact package name and version, the reason, and a reference URL when one exists. Wildcards are not allowed. Each entry is reviewed in the PR that adds it.

## CI enforcement

The `dependencies` check runs whenever the [CI policy](ci.md) selects it, and reports to `foundation` like every selected check. A failure blocks the merge. It runs without secrets. Its network access is read-only and limited to the npm registry and the recorded upstream repositories. The script is `.github/scripts/check-dependencies.mjs`, with behavioral tests like the other CI scripts. Run it locally with `node .github/scripts/check-dependencies.mjs`.

| Check | Fails when |
| --- | --- |
| Configuration | `.npmrc` lacks a required setting, or `.node-version` is not one exact version. |
| Exact pins | A `package.json` dependency is not an exact registry version, or an `overrides` entry is not exact. |
| Lockfile sources | A lockfile entry resolves outside `registry.npmjs.org` or lacks a `sha512` integrity value. |
| Install scripts | A LINA package defines an install lifecycle script or a `pre` or `post` hook, or a lockfile entry has `hasInstallScript` without an exception. |
| Signatures | `npm audit signatures` after `npm ci --ignore-scripts` reports a missing or invalid signature or an invalid attestation. |
| Vendored trees | A file under `vendor/<name>/upstream/` is missing from `vendor.json` or does not match it, a patch record is incomplete, or the notices entry is missing or names another commit. |
| Upstream fetch | For a changed `vendor.json`, the recorded upstream commit or generator output does not match the recorded upstream hashes, or the recorded patches do not reproduce the tree. |
| Exceptions | An exceptions entry is malformed, uses a wildcard, or lacks a reason. |

The Actions summary lists packages that the change adds, removes, or updates, their versions, and the total transitive package count.

## Deferred

- The baseline lockfile and transitive package count are recorded by the supply-chain baseline in the first implementation issue. Exact pins are deferred in [runtime.md](../design/runtime.md).
