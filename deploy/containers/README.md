# Containerized Lina

This packages the whole Lina runtime. It starts its own Codex processes, keeps
data in a named volume and exposes only the web port on host loopback. It does
not mount host credentials, the host home, Docker's socket or Codex's control
socket. It does not create an independent graphical desktop.

From the repository root:

```sh
docker compose -f deploy/containers/compose.yml build
docker compose -f deploy/containers/compose.yml up -d
```

Open http://127.0.0.1:7980. Choose a different host port if another Lina already
uses it. The controller stays on container loopback. Configure an authenticated
OpenCodex Hub reachable from the container with LINA_OPENCODEX_BASE_URL and a
separately mounted token file referenced by LINA_OPENCODEX_TOKEN_FILE; the example
does not copy host secrets or assume the host's loopback is reachable. Provider
configuration is required for inference, not for the settings page.

The image pins Bun 1.4.0 and Codex CLI 0.153.4. The final image retains the shell
and the tools required by the agent workload; it is not a shell-free web image.
No host application control is granted by this compose file. Adding writable
mounts, network access or host connectors changes the access boundary. The default
container has outbound network access; it is not an egress-restricted environment.

`compose down` retains lina-data. Do not use `down -v` when retaining agent state.
For checkpoints, stop Lina first and invoke the CLI with the same data volume:

```sh
docker compose -f deploy/containers/compose.yml stop lina
docker compose -f deploy/containers/compose.yml run --rm --entrypoint bun lina /app/packages/lina-runtime/scripts/lina.ts checkpoint create
```

These commands are installation instructions, not proof of macOS/Windows Docker
support, model inference, a full memory backup, or a tested desktop VM. Verification
for the current revision belongs in the implementation unit.
