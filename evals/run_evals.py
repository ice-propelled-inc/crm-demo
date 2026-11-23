"""Live LLM eval harness. Build step 11 makes it. Until then it stops with an error."""

import sys


def main() -> int:
    print("The eval harness is not built yet (DESCRIPTION.md, Part 2, step 11).", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
