# Use the public ECR mirror of Docker Official Images to avoid Docker Hub
# auth/rate-limit failures on GitHub-hosted runners.
FROM public.ecr.aws/docker/library/node:20-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ainyc/canonry build
RUN pnpm deploy --legacy --filter @ainyc/canonry --prod /prod/app

FROM public.ecr.aws/docker/library/node:20-bookworm-slim

ENV NODE_ENV=production
ENV CANONRY_CONFIG_DIR=/data/canonry
ENV PORT=4100

WORKDIR /app

COPY --from=build /prod/app ./
COPY docker/entrypoint.sh /usr/local/bin/canonry-entrypoint

RUN chmod +x /usr/local/bin/canonry-entrypoint \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "const port = process.env.CANONRY_PORT || process.env.PORT || '4100'; fetch('http://127.0.0.1:' + port + '/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["canonry-entrypoint"]
