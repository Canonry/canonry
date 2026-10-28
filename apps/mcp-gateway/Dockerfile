FROM public.ecr.aws/docker/library/node:26.12.1-bookworm-slim@sha256:1e96b01216cab31612cd1f9480e83413472dee8686d423cb4c1ec62bf8a26e9e AS build

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

FROM public.ecr.aws/docker/library/node:26.12.1-bookworm-slim@sha256:1e96b01216cab31612cd1f9480e83413472dee8686d423cb4c1ec62bf8a26e9e

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
