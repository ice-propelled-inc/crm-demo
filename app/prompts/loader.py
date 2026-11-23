"""Read the default prompt templates from `app/prompts/defaults/{lang}/*.md`.

The file name without `.md` is the prompt key, for example `sales_funnel.offer`.
"""

from pathlib import Path

DEFAULTS_DIR = Path(__file__).parent / "defaults"

REQUIRED_KEYS = frozenset({"system", "greeting", "fallback", "escalation", "order_confirmation"})
DEFAULT_FUNNEL_STAGES = (
    "greeting",
    "needs_discovery",
    "offer",
    "order",
    "payment",
    "status_notifications",
    "feedback",
)


def load_default_prompts(directory: Path = DEFAULTS_DIR) -> dict[tuple[str, str], str]:
    """Return {(language, key): body} for all default prompt files."""
    prompts: dict[tuple[str, str], str] = {}
    for lang_dir in sorted(p for p in directory.iterdir() if p.is_dir()):
        for file in sorted(lang_dir.glob("*.md")):
            prompts[(lang_dir.name, file.stem)] = file.read_text(encoding="utf-8")
    return prompts
