from __future__ import annotations

import json
import threading
from http.server import ThreadingHTTPServer
from urllib.request import urlopen

from transformersci.otel import pr_ci_view, trace_exporter


def test_source_lookup_selects_latest_valid_run_per_lane(monkeypatch) -> None:
    monkeypatch.setattr(
        trace_exporter, "prometheus_base_url", lambda: "http://prometheus"
    )
    monkeypatch.setattr(
        trace_exporter,
        "_http_get_json",
        lambda *args, **kwargs: {
            "status": "success",
            "data": {
                "result": [
                    {
                        "metric": {"run_id": "101:1", "ci_event": "none"},
                        "value": [0, "100"],
                    },
                    {
                        "metric": {"run_id": "102:1", "ci_event": "pr-comment"},
                        "value": [0, "110"],
                    },
                    {
                        "metric": {"run_id": "103:1", "ci_event": "none"},
                        "value": [0, "120"],
                    },
                ]
            },
        },
    )
    runs = {
        "101": {
            "path": ".github/workflows/pr-ci-caller.yml@main",
            "event": "pull_request",
        },
        "102": {
            "path": ".github/workflows/self-comment-ci.yml@main",
            "event": "issue_comment",
        },
        "103": {
            "path": ".github/workflows/rerun-failed-tests.yml@main",
            "event": "workflow_dispatch",
        },
    }
    monkeypatch.setattr(
        trace_exporter, "_rerun_github_api", lambda path: runs[path.rsplit("/", 1)[1]]
    )
    sources = object.__new__(trace_exporter.MetricsHandler)._pr_ci_sources("49599")
    assert sources["cpu"]["source_run"]["run_id"] == "101:1"
    assert sources["gpu"]["source_run"]["run_id"] == "102:1"


def test_run_slow_comparison_matches_the_run_and_artifact() -> None:
    body = """## CI (Nvidia + AMD)
<!-- nvidia-section-start -->
### Nvidia CI
[Workflow Run](https://github.com/huggingface/transformers/actions/runs/123)
| RUN | [a](https://github.com/huggingface/transformers/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) |
| PR | [b](https://github.com/huggingface/transformers/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) |
| main | [c](https://github.com/huggingface/transformers/commit/cccccccccccccccccccccccccccccccccccccccc) |
❌ **[1 new failed tests from this PR](https://huggingface.co/datasets/example/report/new_failures_with_bad_commit.json)**
<!-- nvidia-section-end -->
<!-- amd-section-start -->
### AMD CI
[Workflow Run](https://github.com/huggingface/transformers/actions/runs/456)
✅ No failing test specific to this PR
<!-- amd-section-end -->"""
    comment = {"body": body, "updated_at": "2026-10-14T12:00:00Z"}
    assert pr_ci_view.matching_comment([comment], "123:1") == comment
    assert pr_ci_view.matching_comment([comment], "999:1") is None
    assert pr_ci_view.latest_platform_comment([comment], "amd") == comment

    def artifact(url: str) -> object:
        assert (
            url
            == "https://huggingface.co/datasets/example/report/new_failures_with_bad_commit.json"
        )
        return {
            "vit": {
                "single-gpu": [
                    {
                        "test": "tests/models/vit/test_vit.py::test_regression",
                        "bad_commit": "a",
                        "status": "new",
                    },
                    {
                        "test": "tests/models/vit/test_vit.py::test_existing",
                        "bad_commit": None,
                    },
                ]
            }
        }

    nvidia = pr_ci_view.comparison(body, "nvidia", artifact)
    assert nvidia["state"] == "complete"
    assert nvidia["run_id"] == "123"
    assert nvidia["commits"]["main"] == "c" * 40
    assert [item["nodeid"] for item in nvidia["specific"]] == [
        "tests/models/vit/test_vit.py::test_regression"
    ]
    assert pr_ci_view.comparison(body, "amd", artifact)["specific"] == []

    rows = [
        {
            "test_nodeid": "tests/models/vit/test_vit.py::test_regression",
            "hardware": "single-gpu",
            "test_job": "run_models_gpu",
            "status_code": "ERROR",
        },
        {
            "test_nodeid": "tests/models/vit/test_vit.py::test_regression",
            "hardware": "multi-gpu",
            "test_job": "run_models_gpu",
            "status_code": "ERROR",
        },
        {
            "test_nodeid": "tests/models/vit/test_vit.py::test_existing",
            "hardware": "single-gpu",
            "test_job": "run_models_gpu",
            "status_code": "ERROR",
        },
    ]
    assert [item["specific"] for item in pr_ci_view.failures(rows, nvidia)] == [
        True,
        False,
        False,
    ]


def test_combined_view_endpoint_serves_both_lanes(monkeypatch) -> None:
    cpu = {
        "run_id": "100:1",
        "url": "https://github.com/huggingface/transformers/actions/runs/100",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-10-14T10:00:00Z",
    }
    gpu = {
        "run_id": "123:1",
        "url": "https://github.com/huggingface/transformers/actions/runs/123",
        "status": "completed",
        "conclusion": "failure",
        "created_at": "2026-10-14T11:00:00Z",
    }
    sources = {
        "cpu": {"source_run": cpu, "active_runs": [], "notes": []},
        "gpu": {"source_run": gpu, "active_runs": [], "notes": []},
    }
    monkeypatch.setattr(
        trace_exporter.MetricsHandler, "_pr_ci_sources", lambda self, pr: sources
    )
    monkeypatch.setattr(
        trace_exporter,
        "gather_run_test_rows",
        lambda run_id: (
            [
                {
                    "test_nodeid": "tests/models/vit/test_vit.py::test_regression",
                    "test_job": "run_models_gpu",
                    "hardware": "single-gpu",
                    "status_code": "ERROR",
                    "pr": "49599",
                }
            ]
            if run_id == "123:1"
            else []
        ),
    )
    comment_body = """<!-- nvidia-section-start -->
[Workflow Run](https://github.com/huggingface/transformers/actions/runs/123)
✅ No failing test specific to this PR
<!-- nvidia-section-end -->
<!-- amd-section-start -->
[Workflow Run](https://github.com/huggingface/transformers/actions/runs/456)
✅ No failing test specific to this PR
<!-- amd-section-end -->"""

    def api(path: str) -> object:
        if path.startswith("issues/"):
            return [{"body": comment_body, "updated_at": "2026-10-14T12:00:00Z"}]
        if path.startswith("actions/runs/100/jobs"):
            return {
                "jobs": [
                    {
                        "name": "pr-ci / tests_torch / tests_torch [shard 0/1]",
                        "status": "completed",
                        "conclusion": "success",
                    }
                ]
            }
        if path.startswith("actions/runs/123/jobs"):
            return {
                "jobs": [
                    {
                        "name": "Model CI / run_models_gpu (aws-g5-4xlarge-cache, 0) / run_models_gpu (models/vit)",
                        "status": "completed",
                        "conclusion": "failure",
                    }
                ]
            }
        if path == "actions/runs/456":
            return {
                "id": 456,
                "path": ".github/workflows/self-comment-ci-amd.yml@main",
                "event": "issue_comment",
                "status": "completed",
                "conclusion": "success",
            }
        if path.startswith("actions/runs/456/jobs"):
            return {
                "jobs": [
                    {
                        "name": "Model CI / run_models_gpu (2gpu, 0) / run_models_gpu (models/vit)",
                        "status": "completed",
                        "conclusion": "success",
                    }
                ]
            }
        raise AssertionError(path)

    monkeypatch.setattr(trace_exporter, "_rerun_github_api", api)
    server = ThreadingHTTPServer(("127.0.0.1", 0), trace_exporter.MetricsHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        with urlopen(f"{base}/pr-ci-view?pr=49599", timeout=5) as response:
            page = response.read()
            assert b"Latest Run Jobs" in page
            assert b'data-group="test_model"' in page
            assert b"Only PR-specific run-slow failures" in page
        with urlopen(f"{base}/pr-ci-view/app.js", timeout=5) as response:
            assert b"Only PR-specific" not in response.read()
        with urlopen(f"{base}/pr-ci-view/data?pr=49599", timeout=5) as response:
            payload = json.load(response)
    finally:
        server.shutdown()
        server.server_close()
    assert [lane["id"] for lane in payload["lanes"]] == ["cpu", "gpu", "amd"]
    assert payload["lanes"][0]["jobs"][0]["name"] == "tests_torch"
    assert payload["lanes"][1]["comparison"]["state"] == "complete"
    assert payload["lanes"][1]["failures"][0]["specific"] is False
    assert payload["lanes"][1]["failures"][0]["model"] == "vit"
    assert payload["lanes"][2]["jobs"][0]["hardware"] == "amd-2gpu"
