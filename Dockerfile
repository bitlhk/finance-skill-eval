# Standalone API entry; the managed production stack uses deploy/docker/Dockerfile.
FROM docker:29.1.3-cli AS docker-cli
FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --no-optional --ignore-scripts --child-concurrency=1 --network-concurrency=4
RUN npm install --prefix /tmp/native-build-tools --ignore-scripts --no-package-lock \
  @rollup/rollup-linux-x64-gnu@4.63.1 @esbuild/linux-x64@0.25.12 \
  && cp -R /tmp/native-build-tools/node_modules/@rollup /app/node_modules/@rollup \
  && cp -R /tmp/native-build-tools/node_modules/@esbuild /app/node_modules/@esbuild
COPY . .
RUN pnpm build && pnpm prune --prod --no-optional

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/uv \
  && /opt/uv/bin/pip install --no-cache-dir uv==0.12.13

ENV NODE_ENV=production
ENV FINANCE_EVAL_HOST=0.0.0.0
ENV FINANCE_EVAL_PORT=56361
ENV FINANCE_EVAL_ROOT=/app
ENV FINANCE_EVAL_DATA_DIR=/app/data
ENV FINANCE_EVAL_MIGRATION_PYTHON=/app/.venv-openjiuwen/bin/python
ENV PYTHONUTF8=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY integrations/openjiuwen/pyproject.toml integrations/openjiuwen/uv.lock /app/integrations/openjiuwen/
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN UV_PROJECT_ENVIRONMENT=/app/.venv-openjiuwen /opt/uv/bin/uv sync --locked --project /app/integrations/openjiuwen --python 3.12 --managed-python --no-dev
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web-dist ./web-dist
COPY --from=build --chown=node:node /app/packs ./packs
COPY --chown=node:node src ./src
COPY --chown=node:node integrations ./integrations
COPY --chown=node:node contracts ./contracts
COPY --chown=node:node docs/2.0/skill-specification.md ./docs/2.0/skill-specification.md
ENV PYTHONPATH=/app/src:/app
ENV PATH=/opt/uv/bin:$PATH
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 56361
VOLUME ["/app/data"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:56361/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
COPY --chown=node:node scripts ./scripts
CMD ["node", "scripts/serve-api.mjs"]
