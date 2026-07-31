.PHONY: install check verify typecheck test lint dev build serve publish release

# Fast local checks: typecheck, lint, and tests
check: typecheck lint test

# Full local preflight, including package and container smoke tests
verify:
	pnpm run verify

install:
	pnpm install

typecheck:
	pnpm run typecheck

test:
	pnpm run test

lint:
	pnpm run lint

dev:
	pnpm run dev:web

# Build the canonry package (TypeScript + bundled SPA)
build:
	pnpm --filter @canonry/canonry run build

# Build and serve the SPA locally
serve: build
	node packages/canonry/bin/canonry.mjs serve --host 0.0.0.0 --port 4100

# Publish to npm (runs build via prepublishOnly)
publish:
	cd packages/canonry && npm publish --access public

# Build + publish in one command after full validation
release: verify publish
