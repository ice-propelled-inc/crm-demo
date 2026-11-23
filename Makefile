# AI-chat-helper tasks. Works on Windows (GNU make + cmd) and Linux/macOS.

ifeq ($(OS),Windows_NT)
    PY := .venv\Scripts\python.exe
    VENV_PY := python
else
    PY := .venv/bin/python
    VENV_PY := python3
endif

FRONTENDS := frontend/admin frontend/operator

.PHONY: install dev down migrate seed-dev api-types test test-backend test-frontend lint lint-backend lint-frontend eval

install:  ## Create the virtual environment and install all dependencies
	$(VENV_PY) -m venv .venv
	$(PY) -m pip install --upgrade pip
	$(PY) -m pip install -e ".[dev]"
	cd frontend/admin && npm install
	cd frontend/operator && npm install

dev:  ## Start Postgres, the backend, the mocks and the two SPAs
	docker compose up -d --build
	docker compose exec app alembic upgrade head

down:
	docker compose down

migrate:  ## Run the migrations against DATABASE_URL
	$(PY) -m alembic upgrade head

seed-dev:  ## Tenant for the mock CRM, with a Jivo channel, operators and an urgent manager
	docker compose exec app python -m app.cli seed-dev

api-types:  ## OpenAPI schema -> TypeScript types of the two SPAs
	$(PY) -m app.export_openapi frontend/openapi.json
	cd frontend/admin && npm run gen:api
	cd frontend/operator && npm run gen:api

test: test-backend test-frontend

# Integration tests need the compose `db` service: `docker compose up -d db`.
test-backend:
	$(PY) -m pytest --cov=app --cov-branch --cov-report=term-missing:skip-covered
	$(PY) -m coverage report --include="app/domain/*" --fail-under=100

test-frontend:
	cd frontend/admin && npm test
	cd frontend/operator && npm test

lint: lint-backend lint-frontend

lint-backend:
	$(PY) -m ruff check .
	$(PY) -m ruff format --check .
	$(PY) -m mypy app mocks

lint-frontend:
	cd frontend/admin && npm run lint && npm run typecheck
	cd frontend/operator && npm run lint && npm run typecheck

eval:  ## Live LLM evals (build step 11)
	$(PY) evals/run_evals.py
