FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY data ./data
COPY deploy/containers ./deploy/containers
WORKDIR /opt/codex
RUN printf '{"private":true,"dependencies":{"@openai/codex":"0.153.4"}}\n' > package.json \
    && bun install --production --ignore-scripts

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
COPY --from=build /app /app
COPY --from=build /opt/codex /opt/codex
COPY --chmod=755 deploy/containers/codex /usr/local/bin/lina-codex
RUN mkdir -p /home/bun/.lina && chown bun:bun /home/bun/.lina
USER bun
WORKDIR /app
ENV LINA_HOME=/home/bun/.lina LINA_CODEX_TASK_MODE=owned LINA_CODEX_COMMAND=/usr/local/bin/lina-codex
EXPOSE 7980
ENTRYPOINT ["bun", "/app/packages/lina-runtime/scripts/start-container.ts"]
