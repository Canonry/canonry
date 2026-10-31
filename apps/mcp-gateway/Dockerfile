FROM public.ecr.aws/docker/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /build
RUN npm install --global pnpm@12.14.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @canonry/canonry-mcp-gateway build
RUN pnpm deploy --legacy --filter @canonry/canonry-mcp-gateway --prod /prod/gateway

FROM public.ecr.aws/docker/library/node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /prod/gateway ./
RUN mkdir -p /data \
  && chown node:node /data \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
VOLUME ["/data"]
EXPOSE 4101
CMD ["node", "dist/index.js"]
