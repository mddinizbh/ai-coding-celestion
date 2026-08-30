from pathlib import Path
import subprocess
import sys


def test_scaffold_creates_runnable_canvas(tmp_path: Path) -> None:
    # Given
    script = Path(__file__).parents[1] / "scripts" / "create_canvas.py"
    output = tmp_path / "canvas"

    # When
    result = subprocess.run(
        [sys.executable, str(script), "--out", str(output), "--title", "Payments"],
        capture_output=True,
        check=False,
        text=True,
    )

    # Then
    assert result.returncode == 0, result.stderr
    assert (output / "index.html").exists()
    assert (output / "diagram.json").exists()
    assert (output / "assets" / "js" / "app.mjs").exists()
    assert "anchorForPoint" in (output / "assets" / "js" / "geometry.mjs").read_text(encoding="utf-8")
    assert "Payments" in (output / "diagram.json").read_text(encoding="utf-8")
