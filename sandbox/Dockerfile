FROM node:22-bookworm-slim AS node

FROM python:3.11-slim
ARG FASTMCP_VERSION=2.14.7
ARG UV_VERSION=0.8.22
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && pip install --no-cache-dir "fastmcp==${FASTMCP_VERSION}" "uv==${UV_VERSION}"
WORKDIR /workspace
ENV PYTHONUTF8=1 PYTHONUNBUFFERED=1
CMD ["python3", "-c", "raise SystemExit('sandbox command required')"]
