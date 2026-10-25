"""Reject generated projects that the editor cannot import, without truncation.

Keep these limits aligned with src/engine/validate.ts and src/engine/limits.ts.
This is a size check for locally generated data, not an SVG/schema validator.
"""
from dataclasses import dataclass
import json
import re


@dataclass(frozen=True)
class ProjectLimits:
    nodes: int = 8000
    keyframes: int = 300_000
    keys_per_node: int = 5000
    path_bytes: int = 64_000_000
    path_coordinates: int = 8_000_000
    bytes_per_path: int = 100_000
    coordinates_per_path: int = 20_000
    gradient_stops: int = 1_000_000
    json_bytes: int = 96 * 1024 * 1024


PROJECT_LIMITS = ProjectLimits()
PATH_NUMBER = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def require_budget(label: str, actual: int, maximum: int, unit: str = "개") -> None:
    if actual > maximum:
        raise ValueError(
            f"분석 결과가 편집기 한도를 초과했습니다: {label} "
            f"({actual:,}{unit} / 한도 {maximum:,}{unit}). "
            "요소를 임의로 생략하지 않고 분석을 중단했습니다. "
            "더 짧은 영상 구간을 선택하거나 빠른 분석으로 다시 시도해 주세요."
        )


def check_project_budget(project: dict, limits: ProjectLimits = PROJECT_LIMITS) -> None:
    """Measure every stored occurrence, including a path repeated in a keyframe."""
    nodes = project["nodes"]
    require_budget("요소 수", len(nodes), limits.nodes)
    keyframes = path_bytes = coordinates = gradient_stops = 0
    for node in nodes:
        keys = node.get("keyframes", [])
        require_budget("한 요소의 키프레임 수", len(keys), limits.keys_per_node)
        keyframes += len(keys)
        for item in (node, *keys):
            for field in ("path", "occlusionPath"):
                path = item.get(field)
                if path:
                    size = len(path.encode("utf-8"))
                    count = sum(1 for _ in PATH_NUMBER.finditer(path))
                    require_budget("한 SVG 경로 크기", size, limits.bytes_per_path, "바이트")
                    require_budget("한 SVG 경로 좌표 수", count, limits.coordinates_per_path)
                    path_bytes += size
                    coordinates += count
            gradient = item.get("gradient")
            if gradient:
                gradient_stops += len(gradient["stops"])
    require_budget("전체 키프레임 수", keyframes, limits.keyframes)
    require_budget("전체 SVG 경로 크기", path_bytes, limits.path_bytes, "바이트")
    require_budget("전체 SVG 경로 좌표 수", coordinates, limits.path_coordinates)
    require_budget("전체 그라데이션 stop 수", gradient_stops, limits.gradient_stops)
    # Stream UTF-8 accounting rather than allocate a second large JSON buffer.
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    json_bytes = sum(len(chunk.encode("utf-8")) for chunk in encoder.iterencode(project))
    require_budget("프로젝트 JSON 크기", json_bytes, limits.json_bytes, "바이트")
