FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

# Copy and install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js ./
COPY apps ./apps
COPY packages ./packages
COPY skills ./skills

RUN pnpm install --frozen-lockfile
RUN pnpm -r run build

# The test script will be mounted at runtime
ENTRYPOINT ["/bin/bash"]
