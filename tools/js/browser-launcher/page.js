// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * The page half of a browser scenario: the logs SDK and, for a scenario that
 * expects spans, the web tracing SDK, both exporting to the page's own origin,
 * which the launcher relays to the runner.
 *
 * Bundled into the page, never loaded by Node.
 */

const {
  BatchLogRecordProcessor,
  LoggerProvider,
} = require("@opentelemetry/sdk-logs");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-proto");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const {
  BatchSpanProcessor,
  WebTracerProvider,
} = require("@opentelemetry/sdk-trace-web");

const EVENTS_TIMEOUT_MILLIS = 20_000;

/**
 * Counts records by event name, and ended spans as `spans`. `emitted()`
 * resolves once each name in `expected` has been seen at least as often as it
 * says, since a browser event arrives from a listener or an observer after the
 * workload returned, and a fetch span ends only once its body has been read.
 */
function counting(expected) {
  const seen = {};
  let wake = () => {};
  const done = () =>
    Object.entries(expected).every(([name, count]) => seen[name] >= count);
  const count = (name) => {
    seen[name] = (seen[name] ?? 0) + 1;
    if (done()) {
      wake();
    }
  };
  return {
    seen,
    emitted: () =>
      done() ? Promise.resolve() : new Promise((resolve) => (wake = resolve)),
    processor: {
      onEmit: (record) => count(record.eventName ?? ""),
      forceFlush: async () => {},
      shutdown: async () => {},
    },
    spanProcessor: {
      onStart() {},
      onEnd: () => count("spans"),
      forceFlush: async () => {},
      shutdown: async () => {},
    },
  };
}

function within(promise, millis, describe) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(describe())), millis);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Registers `instrumentations` and exposes `workload` to the launcher, which
 * calls it once with its input and waits until the `events` it names and the
 * number of `spans` have been emitted and their export answered. What the
 * workload returns goes back to the launcher with the counts.
 */
function exposeScenario(
  { instrumentations = [], events = {}, spans = 0 } = {},
  workload,
) {
  const expected = spans > 0 ? { ...events, spans } : events;
  const counted = counting(expected);
  const provider = new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: new URL("/v1/logs", location.href).href,
        }),
      }),
      counted.processor,
    ],
  });
  // Only when spans are expected, so an events scenario records no spans.
  const tracerProvider =
    spans > 0
      ? new WebTracerProvider({
          spanProcessors: [
            new BatchSpanProcessor(
              new OTLPTraceExporter({
                url: new URL("/v1/traces", location.href).href,
              }),
            ),
            counted.spanProcessor,
          ],
        })
      : undefined;
  // Registered globally, as a page would, for its context and propagation.
  tracerProvider?.register();
  registerInstrumentations({
    instrumentations,
    loggerProvider: provider,
    tracerProvider,
  });

  globalThis.runScenario = async (input) => {
    const result = await workload(input);
    await within(
      counted.emitted(),
      EVENTS_TIMEOUT_MILLIS,
      () =>
        `expected ${JSON.stringify(expected)}, ` +
        `emitted ${JSON.stringify(counted.seen)}`,
    );
    // Resolves when the relay has answered, which it does only after the
    // runner's bridge has handed the records to weaver.
    await Promise.all([provider.forceFlush(), tracerProvider?.forceFlush()]);
    return { result, seen: counted.seen };
  };
}

module.exports = { exposeScenario };
