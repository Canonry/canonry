# Use the public ECR mirror of Docker Official Images to avoid Docker Hub
# auth/rate-limit failures on GitHub-hosted runners.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

# `better-sqlite3` installs via `prebuild-install || node-gyp rebuild`. The
# prebuilt download is a single un-retried network fetch, and without a
# toolchain the `||` fallback CANNOT succeed — so one blip on the prebuild CDN
# fails the whole image build. Observed: `prebuild-install warn install socket
# hang up` followed by `gyp ERR! Could not find any Python installation`.
#
# This is the BUILD stage only; the runtime stage below copies `/prod/app` and
# never sees these packages, so the shipped image is unchanged.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @canonry/canonry build
RUN pnpm deploy --legacy --filter @canonry/canonry --prod /prod/app

FROM public.ecr.aws/docker/library/node:22-bookworm-slim

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

# Liveness probe. Deliberately NOT `node -e`: booting a second Node runtime costs
# ~51 MiB RSS and ~106 ms EVERY interval, in EVERY container (measured on a live
# bookworm-slim engine container). bash's /dev/tcp does the same HTTP GET for
# ~1.6 MiB and ~3 ms with no added packages: the slim base ships bash but has no
# curl, wget, or netcat.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${CANONRY_PORT:-${PORT:-4100}} && printf 'GET /health HTTP/1.0\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q '^HTTP/1\\.[01] 200'"]

ENTRYPOINT ["canonry-entrypoint"]
