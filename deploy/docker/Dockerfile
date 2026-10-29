FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/uv \
    && /opt/uv/bin/pip install --no-cache-dir uv==0.12.13
WORKDIR /app
COPY integrations/openjiuwen/pyproject.toml integrations/openjiuwen/uv.lock /app/integrations/openjiuwen/
RUN UV_PROJECT_ENVIRONMENT=/app/.venv-openjiuwen /opt/uv/bin/uv sync --locked --project /app/integrations/openjiuwen --python python3 --no-dev
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web-dist
COPY --from=build /app/packs ./packs
COPY integrations ./integrations
COPY deploy ./deploy
ENV NODE_ENV=production PYTHONUTF8=1 PYTHONUNBUFFERED=1
ENV FINANCE_EVAL_DATA_DIR=/app/data FINANCE_RUNTIME_CONFIG=/run/config/runtime.json
ENV FINANCE_EVAL_HOST=0.0.0.0 FINANCE_RUNTIME_HOST=0.0.0.0
ENV FINANCE_EVAL_MIGRATION_PYTHON=/app/.venv-openjiuwen/bin/python
ENV UV_CACHE_DIR=/app/cache
RUN mkdir -p /app/data /app/cache && chown -R node:node /app/data /app/cache
USER node
EXPOSE 56361
CMD ["node", "deploy/run.mjs", "api"]
