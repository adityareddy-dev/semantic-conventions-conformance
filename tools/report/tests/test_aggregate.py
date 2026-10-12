# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0

"""Joining a `data.json` to what the registry declares."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml

from conformance_report import _aggregate, build, render, signal_coverage
from conftest import MODEL, write_target

EMPTY: dict[str, Any] = {
    "spans": {},
    "events": {},
    "metrics": {},
    "entities": {},
    "findings": [],
}


def coverage_of(data: dict[str, Any]) -> dict[str, Any]:
    return {s["name"]: s for s in signal_coverage(data, MODEL)}


def test_coverage_counts_each_level_separately() -> None:
    """A level is only comparable against itself, so each is its own tally."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required", "demo.optional"]}}
    )
    assert signals["demo.client"]["coverage"] == {
        "conditionally_required_conditional": {"emitted": 0, "declared": 1},
        "opt_in": {"emitted": 1, "declared": 1},
        "recommended": {"emitted": 0, "declared": 1},
        "required": {"emitted": 1, "declared": 2},
    }


def test_missing_is_what_was_declared_and_did_not_arrive() -> None:
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required"]}}
    )
    assert signals["demo.client"]["missing"] == [
        "demo.also_required",
        "demo.conditional",
        "demo.optional",
        "demo.recommended",
    ]


def test_an_attribute_outside_the_registry_is_not_counted() -> None:
    """The `data.json` already dropped it, and the join must not restore it."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required", "made.up"]}}
    )
    assert signals["demo.client"]["coverage"]["required"] == {
        "emitted": 1,
        "declared": 2,
    }


def test_a_signal_the_registry_does_not_declare_has_no_denominator() -> None:
    """Null, not zero: "unknown coverage" is not "no coverage"."""
    signals = coverage_of({**EMPTY, "spans": {"mystery.client": ["a"]}})
    assert signals["mystery.client"]["declared"] is None
    assert "coverage" not in signals["mystery.client"]


def test_spans_carry_the_identity_the_explorer_keys_on() -> None:
    """Span kind plus the attribute set, which is how it diffs telemetry."""
    signals = coverage_of(
        {**EMPTY, "spans": {"demo.client": ["demo.required"]}}
    )
    assert signals["demo.client"]["identity"] == {
        "span_kind": "client",
        "attributes": ["demo.required"],
    }


def test_a_metric_is_keyed_by_name_alone() -> None:
    """No identity block at all: an attribute set would split one metric.

    The explorer keys a metric by name, so two observations under one name are
    one metric there, however differently they were attributed.
    """
    signals = coverage_of({**EMPTY, "metrics": {"demo.duration": []}})
    assert "identity" not in signals["demo.duration"]
    assert signals["demo.duration"]["name"] == "demo.duration"


def test_the_summary_sums_only_the_scored_levels() -> None:
    """Conditional and opt-in are reported, never scored. See the README."""
    signals = signal_coverage(
        {
            **EMPTY,
            "spans": {"demo.client": ["demo.required"]},
            "metrics": {"demo.duration": ["demo.recommended"]},
        },
        MODEL,
    )
    assert _aggregate._summary(signals) == {
        "required": {"emitted": 1, "declared": 3},
        "recommended": {"emitted": 1, "declared": 2},
        "findings": 0,
    }


def test_opt_ins_do_not_reduce_scored_coverage() -> None:
    signals = signal_coverage(
        {
            "spans": {
                "demo.client": [
                    "demo.required",
                    "demo.also_required",
                    "demo.recommended",
                ]
            }
        },
        MODEL,
    )
    summary = _aggregate._summary(signals)
    for level in _aggregate.SCORED_LEVELS:
        assert summary[level]["emitted"] == summary[level]["declared"] > 0
    assert signals[0]["coverage"]["opt_in"] == {"emitted": 0, "declared": 1}


@pytest.mark.usefixtures("one_domain")
def test_database_metadata_preserves_backend_and_instrumentation(
    tmp_path: Path,
) -> None:
    write_target(
        tmp_path,
        "database/java/mariadb/jdbc/opentelemetry-javaagent",
        library="jdbc",
        instrumentation="io.opentelemetry.javaagent",
    )
    (target,) = build(tmp_path)["targets"]
    assert target["backend"] == "mariadb"
    assert target["label"] == "opentelemetry-javaagent"
    assert target["instrumented_library"] == "jdbc"
    assert target["instrumentation_library"] == "io.opentelemetry.javaagent"


def configuration_target(
    tmp_path: Path,
    env: dict[str, str],
    scenarios: dict[str, dict[str, str]],
) -> dict[str, Any]:
    directory = write_target(
        tmp_path,
        "demo/python/demo/opentelemetry-demo",
        scenarios=tuple(scenarios),
    )
    spec_path = directory / "conformance.yaml"
    spec = yaml.safe_load(spec_path.read_text(encoding="utf-8"))
    spec["env"] = env
    for name, overrides in scenarios.items():
        spec["scenarios"][name]["env"] = overrides
    spec_path.write_text(
        yaml.safe_dump(spec, sort_keys=False), encoding="utf-8"
    )
    (target,) = build(tmp_path)["targets"]
    return target


@pytest.mark.usefixtures("one_domain")
def test_configuration_includes_instrumentation_settings(
    tmp_path: Path,
) -> None:
    env = {
        "OTEL_SEMCONV_STABILITY_OPT_IN": "database",
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT": "true",
        "OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED": "false",
        "OTEL_INSTRUMENTATION_EXAMPLE_ENABLED": "false",
    }
    target = configuration_target(tmp_path, env, {"main": {}})
    assert target["configuration"] == {"main": env}
    serialized = json.loads(render({"targets": [target]}))
    assert serialized["targets"][0]["configuration"] == {"main": env}


@pytest.mark.usefixtures("one_domain")
def test_configuration_excludes_test_setup_and_credentials(
    tmp_path: Path,
) -> None:
    env = {
        "JDBC_PASSWORD": "package-secret",
        "JDBC_URL": "jdbc:example",
        "OTEL_EXPORTER_OTLP_HEADERS": "authorization=secret",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
        "OTEL_CONFIG_FILE": "test-config.yaml",
        "OTEL_SEMCONV_STABILITY_OPT_IN_EXTRA": "not-an-opt-in",
        "OTEL_INSTRUMENTATION": "not-a-prefixed-setting",
    }
    target = configuration_target(
        tmp_path, env, {"main": {"API_KEY": "scenario-secret"}}
    )
    assert target["configuration"] == {"main": {}}
    serialized = render({"configuration": target["configuration"]})
    assert "secret" not in serialized


@pytest.mark.usefixtures("one_domain")
def test_configuration_merges_package_and_scenario_settings(
    tmp_path: Path,
) -> None:
    opt_in = "OTEL_SEMCONV_STABILITY_OPT_IN"
    runtime = "OTEL_INSTRUMENTATION_RUNTIME_TELEMETRY_ENABLED"
    target = configuration_target(
        tmp_path,
        {opt_in: "database", runtime: "false"},
        {
            "overridden": {opt_in: "database/dup"},
            "inherited": {},
        },
    )
    assert target["configuration"] == {
        "inherited": {opt_in: "database", runtime: "false"},
        "overridden": {opt_in: "database/dup", runtime: "false"},
    }


@pytest.mark.usefixtures("one_domain")
def test_configuration_does_not_capture_the_process_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opt_in = "OTEL_SEMCONV_STABILITY_OPT_IN"
    monkeypatch.setenv(opt_in, "ambient-override")
    monkeypatch.setenv("OTEL_INSTRUMENTATION_EXAMPLE_ENABLED", "true")
    target = configuration_target(
        tmp_path, {opt_in: "${OPT_IN}"}, {"main": {}}
    )
    assert target["configuration"] == {"main": {opt_in: "${OPT_IN}"}}


@pytest.mark.usefixtures("one_domain")
def test_configuration_retains_scenarios_with_no_settings(
    tmp_path: Path,
) -> None:
    target = configuration_target(tmp_path, {}, {"second": {}, "first": {}})
    assert target["configuration"] == {"first": {}, "second": {}}


@pytest.mark.usefixtures("one_domain")
def test_configuration_order_does_not_depend_on_yaml_order(
    tmp_path: Path,
) -> None:
    env = {
        "OTEL_SEMCONV_STABILITY_OPT_IN": "database",
        "OTEL_INSTRUMENTATION_EXAMPLE_ENABLED": "false",
    }
    scenarios = {"second": {}, "first": {}}
    before = configuration_target(tmp_path, env, scenarios)
    after = configuration_target(
        tmp_path,
        dict(reversed(list(env.items()))),
        dict(reversed(list(scenarios.items()))),
    )
    assert list(before["configuration"]) == ["first", "second"]
    assert list(before["configuration"]["first"]) == sorted(env)
    assert render({"targets": [before]}) == render({"targets": [after]})


def test_the_registry_slice_holds_only_what_was_referenced() -> None:
    """The registries declare thousands of signals. These touch a handful."""
    referenced = _aggregate._referenced(
        MODEL, [{**EMPTY, "spans": {"demo.client": []}}]
    )
    assert list(referenced["spans"]) == ["demo.client"]
    assert referenced["metrics"] == {}
    assert referenced["events"] == {}


def test_rendering_sorts_keys_and_ends_in_a_newline() -> None:
    """A rebuild is compared byte-for-byte, so order cannot wobble."""
    rendered = render({"b": [2, 1], "a": {"z": 1, "y": 2}})
    assert rendered.startswith('{\n  "a"')
    assert rendered.endswith("\n")
    # Sequences keep the order the report gave them; only keys are sorted.
    assert '"b": [\n    2,\n    1\n  ]' in rendered


def test_an_empty_checkout_says_so(tmp_path: Path) -> None:
    (tmp_path / "scenarios").mkdir()
    with pytest.raises(RuntimeError, match="no conformance directories"):
        build(tmp_path)


@pytest.mark.usefixtures("one_domain")
def test_a_target_with_no_runner_is_a_failure_not_an_empty_score(
    tmp_path: Path,
) -> None:
    """Publishing it would read as declaring nothing, not as unmeasured."""
    write_target(tmp_path, "demo/python/demo/opentelemetry-demo", runner=None)
    with pytest.raises(RuntimeError, match="declares no `runner:`") as raised:
        build(tmp_path)
    assert "demo/python/demo/opentelemetry-demo" in str(raised.value)


@pytest.mark.usefixtures("one_domain")
def test_findings_pass_through_verbatim(tmp_path: Path) -> None:
    """The report must not reinterpret a finding. Weaver already decided."""
    finding = {
        "id": "unit_mismatch",
        "message": "Unit should be '{token}', but found 'token'.",
        "signal_type": "metric",
        "signal_name": "demo.duration",
        "context": {"expected": "{token}", "unit": "token"},
    }
    write_target(
        tmp_path,
        "demo/python/demo/opentelemetry-demo",
        data={**EMPTY, "findings": [finding]},
    )
    (target,) = build(tmp_path)["targets"]
    assert target["findings"] == [finding]
    assert target["summary"]["findings"] == 1
