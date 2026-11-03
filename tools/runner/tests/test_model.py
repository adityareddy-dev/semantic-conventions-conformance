# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Resolving a registry into the coverage model used by reductions."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from opentelemetry.conformance import _model
from opentelemetry.conformance._report import Observed
from opentelemetry.conformance._semconv import _reduce


def test_resolution_invokes_weaver_without_a_shell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []

    def run(
        command: list[str], **_kwargs: object
    ) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        generated = Path(command[-1])
        (generated / "coverage-model.json").write_text('{"spans": {}}')
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(_model, "check_weaver", lambda: None)
    monkeypatch.setattr(_model.subprocess, "run", run)
    registry = tmp_path / "registry"
    output = tmp_path / "cache" / "model.json"

    assert _model.resolve(registry, output) == output
    assert json.loads(output.read_text()) == {"spans": {}}
    assert len(commands) == 1
    assert commands[0][:-1] == [
        "weaver",
        "registry",
        "generate",
        "--quiet",
        "--v2",
        "--registry",
        str(registry),
        "--templates",
        str(_model._TEMPLATES),  # noqa: SLF001
        "coverage-model",
    ]
    assert not Path(commands[0][-1]).exists()


def test_metric_refinements_keep_their_own_ids_and_wire_name(
    tmp_path: Path,
) -> None:
    if shutil.which("weaver") is None:
        pytest.skip("weaver is not installed")
    registry = tmp_path / "registry"
    registry.mkdir()
    (registry / "metrics.yaml").write_text(
        """file_format: definition/2
attributes:
  - key: example.base
    type: string
    brief: Base attribute.
    stability: development
  - key: example.provider
    type: string
    brief: Provider attribute.
    stability: development
metrics:
  - name: example.duration
    brief: Duration.
    stability: development
    requirement_level: recommended
    instrument: histogram
    unit: s
    attributes:
      - ref: example.base
        requirement_level: required
metric_refinements:
  - id: provider.example.duration
    ref: example.duration
    brief: Provider duration.
    stability: development
    attributes:
      - ref: example.provider
        requirement_level: recommended
  - id: other.example.duration
    ref: example.duration
    brief: Other duration.
    stability: development
    attributes:
      - ref: example.provider
        requirement_level: opt_in
""",
        encoding="utf-8",
    )
    model = _model.load(_model.resolve(registry, tmp_path / "model.json"))
    metrics = model["metrics"]

    assert metrics == {
        "example.duration": {"attributes": {"example.base": "required"}},
        "provider.example.duration": {
            "name": "example.duration",
            "attributes": {
                "example.base": "required",
                "example.provider": "recommended",
            },
        },
        "other.example.duration": {
            "name": "example.duration",
            "attributes": {
                "example.base": "required",
                "example.provider": "opt_in",
            },
        },
    }

    # A shared wire name does not establish which refinement applies.
    data = _reduce(
        Observed(
            metrics={"example.duration": {"example.base", "example.provider"}}
        ),
        model,
    )
    assert data["metrics"] == {"example.duration": ["example.base"]}
