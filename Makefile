.PHONY: check typecheck test lint dev

# Run all validation: typecheck, lint, and tests
check: typecheck lint test

typecheck:
	pnpm run typecheck

test:
	pnpm run test

lint:
	pnpm run lint

dev:
	pnpm run dev:web
