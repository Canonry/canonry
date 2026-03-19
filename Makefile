.PHONY: install check typecheck test lint dev build serve publish release

# Run all validation: typecheck, lint, and tests
check: typecheck lint test

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
	pnpm --filter @ainyc/canonry run build

# Build and serve the SPA locally
serve: build
	node packages/canonry/bin/canonry.mjs serve --host 0.0.0.0 --port 4100

# Publish to npm (runs build via prepublishOnly)
publish:
	cd packages/canonry && npm publish --access public

# Build + publish in one command
release: check build publish
