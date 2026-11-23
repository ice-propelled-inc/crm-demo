"""Write the OpenAPI schema: `python -m app.export_openapi frontend/openapi.json`.

The SPAs make their TypeScript API types from this file (`npm run gen:api`).
"""

import json
import sys
from pathlib import Path

from app.main import create_app
from app.runtime import build_test_deps
from app.settings import get_settings


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "frontend/openapi.json")
    schema = create_app(build_test_deps(get_settings())).openapi()
    target.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"OpenAPI schema written to {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
