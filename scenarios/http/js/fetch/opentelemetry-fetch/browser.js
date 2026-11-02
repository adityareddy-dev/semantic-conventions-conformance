// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const {
  FetchInstrumentation,
} = require("@opentelemetry/instrumentation-fetch");
const {
  SimpleSpanProcessor,
  WebTracerProvider,
} = require("@opentelemetry/sdk-trace-web");
const { drive } = require("@otel-conformance/fetch-scenarios");

const { trackingExporter } = require("./tracking-exporter");

async function run() {
  const { baseUrl, exchanges, traceExporterUrl } = window.__otelConformance;
  const exporter = trackingExporter(
    new OTLPTraceExporter({ url: traceExporterUrl }),
    exchanges.filter((exchange) => !exchange.readiness).length,
  );
  const provider = new WebTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({ ignoreUrls: [traceExporterUrl] }),
    ],
  });
  await drive(baseUrl, exchanges);
  await exporter.waitForExpectedSpans();
  await provider.forceFlush();
}

run().then(
  () => {
    window.__otelConformanceResult = { ok: true };
  },
  (error) => {
    window.__otelConformanceResult = {
      ok: false,
      error: String(error.stack || error),
    };
  },
);
