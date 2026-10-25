from copy import deepcopy
from dataclasses import replace
import json
import threading

import pytest

from server import analyzer
from server.budgets import PROJECT_LIMITS, check_project_budget
from tests.backend.test_analysis import NoOCR, make_video


@pytest.fixture
def project():
    path = "M.5 -2e1 L3 4 Z"
    gradient = {"type": "linear", "stops": [{"offset": 0, "color": "#000000"},
                                             {"offset": 1, "color": "#ffffff"}]}
    return {"name": "한글 🎬", "nodes": [{"path": path, "gradient": gradient,
                                         "keyframes": [{"path": path, "gradient": gradient},
                                                       {"occlusionPath": path}]}]}


@pytest.mark.parametrize(("field", "limit", "label"), [
    ("nodes", 0, "요소 수"),
    ("keyframes", 1, "전체 키프레임 수"),
    ("keys_per_node", 1, "한 요소의 키프레임 수"),
    ("path_bytes", 20, "전체 SVG 경로 크기"),
    ("path_coordinates", 11, "전체 SVG 경로 좌표 수"),
    ("bytes_per_path", 10, "한 SVG 경로 크기"),
    ("coordinates_per_path", 3, "한 SVG 경로 좌표 수"),
    ("gradient_stops", 3, "전체 그라데이션 stop 수"),
])
def test_budget_failure_identifies_limit_and_retry_without_mutation(project, field, limit, label):
    original = deepcopy(project)
    with pytest.raises(ValueError) as error:
        check_project_budget(project, replace(PROJECT_LIMITS, **{field: limit}))
    assert label in str(error.value)
    assert f"한도 {limit:,}" in str(error.value)
    assert "더 짧은 영상 구간" in str(error.value)
    assert project == original


def test_repeated_paths_count_separately_and_exact_limit_is_allowed(project):
    path = project["nodes"][0]["path"]
    limits = replace(PROJECT_LIMITS, nodes=1, keyframes=2, keys_per_node=2,
                     path_bytes=3*len(path), path_coordinates=12,
                     bytes_per_path=len(path), coordinates_per_path=4, gradient_stops=4)
    check_project_budget(project, limits)


def test_json_limit_counts_actual_utf8_not_unicode_characters(project):
    encoded = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    byte_count = len(encoded.encode("utf-8"))
    assert byte_count > len(encoded)
    check_project_budget(project, replace(PROJECT_LIMITS, json_bytes=byte_count))
    with pytest.raises(ValueError, match=f"{byte_count:,}바이트"):
        check_project_budget(project, replace(PROJECT_LIMITS, json_bytes=byte_count-1))


def test_high_mode_rejects_tracks_before_truncation(tmp_path, monkeypatch):
    monkeypatch.setattr(analyzer, "VisionOCR", NoOCR)
    monkeypatch.setattr(analyzer, "PROJECT_LIMITS", replace(PROJECT_LIMITS, nodes=1))
    def must_not_convert(*args, **kwargs):
        pytest.fail("oversized high-mode tracks must fail before conversion or truncation")
    monkeypatch.setattr(analyzer, "track_to_node", must_not_convert)
    source = tmp_path/"over-limit.mp4"
    make_video(source, seconds=.3)
    with pytest.raises(ValueError, match="요소 수"):
        analyzer.analyze_video(source, source.name, "/api/media/test.mp4", 24,
                               threading.Event(), lambda *_: None, tmp_path, quality="high")


def test_dense_frame_node_budget_accepts_8000_and_rejects_8001_without_truncation():
    project = {"nodes": [{"keyframes": []} for _ in range(8000)]}
    check_project_budget(project)
    project["nodes"].append({"keyframes": []})
    with pytest.raises(ValueError, match="8,001개 / 한도 8,000개"):
        check_project_budget(project)
    assert len(project["nodes"]) == 8001
