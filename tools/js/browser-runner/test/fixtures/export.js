// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// Deliberately ignore the response status: the runner must catch refused exports.
fetch(window.__otelConformance.traceExporterUrl, {
  method: "POST",
  body: new Uint8Array([1, 2, 3]),
}).then(() => {
  window.__otelConformanceResult = { ok: true };
});
