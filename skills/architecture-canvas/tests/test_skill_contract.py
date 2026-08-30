from pathlib import Path


def test_skill_contract_points_to_ready_engine() -> None:
    # Given
    root = Path(__file__).parents[1]

    # When
    content = (root / "SKILL.md").read_text(encoding="utf-8")

    # Then
    assert "name: architecture-canvas" in content
    assert "scripts/create_canvas.py" in content
    assert "ArchitectureCanvas.validate()" in content
    assert "diagram.json" in content
    assert "SVG artesanal" in content
