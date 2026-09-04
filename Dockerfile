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

ENV NODE_ENV=production
ENV FINANCE_EVAL_HOST=0.0.0.0
ENV FINANCE_EVAL_PORT=56361
ENV FINANCE_EVAL_ROOT=/app
ENV FINANCE_EVAL_DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/web-dist ./web-dist
COPY --from=build --chown=node:node /app/packs ./packs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 56361
VOLUME ["/app/data"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:56361/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/service/server.js"]
