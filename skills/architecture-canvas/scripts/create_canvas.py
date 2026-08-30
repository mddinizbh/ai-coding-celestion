from __future__ import annotations

from pathlib import Path
from shutil import copy2, copytree
import sys


ROOT = Path(__file__).parents[1]
ASSETS = ROOT / "assets"


def parse_arguments(arguments: list[str]) -> tuple[Path, str]:
    """Parse the two supported scaffold arguments without external dependencies."""
    output: Path | None = None
    title = "Architecture Canvas"
    index = 0
    while index < len(arguments):
        option = arguments[index]
        if option == "--out" and index + 1 < len(arguments):
            output = Path(arguments[index + 1]).expanduser()
            index += 2
            continue
        if option == "--title" and index + 1 < len(arguments):
            title = arguments[index + 1]
            index += 2
            continue
        raise ValueError(f"Unknown or incomplete option: {option}")
    if output is None:
        raise ValueError("Missing required option: --out <directory>")
    return output, title


def scaffold(output: Path, title: str) -> None:
    """Copy the portable canvas and replace the example title."""
    output.mkdir(parents=True, exist_ok=True)
    copy2(ASSETS / "index.html", output / "index.html")
    copytree(ASSETS / "js", output / "assets" / "js", dirs_exist_ok=True)
    copy2(ASSETS / "style.css", output / "assets" / "style.css")
    diagram = (ASSETS / "diagram.json").read_text(encoding="utf-8")
    (output / "diagram.json").write_text(diagram.replace("Architecture Canvas", title, 1), encoding="utf-8")


def main(arguments: list[str]) -> int:
    """Create an architecture drawing workspace."""
    try:
        output, title = parse_arguments(arguments)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    scaffold(output, title)
    print(f"Architecture Canvas created at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
