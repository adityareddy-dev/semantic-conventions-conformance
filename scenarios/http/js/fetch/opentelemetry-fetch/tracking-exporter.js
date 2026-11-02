// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/** Resolves once exactly `expected` Fetch spans have reached the exporter. */
function trackingExporter(exporter, expected, timeoutMillis = 10_000) {
  let exported = 0;
  let resolve;
  let reject;
  const complete = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // Handle export failures that arrive before the workload finishes.
  complete.catch(() => {});
  return {
    export(spans, callback) {
      exporter.export(spans, (result) => {
        callback(result);
        if (result.code !== 0) {
          reject(result.error || new Error("OTLP export failed"));
          return;
        }
        exported += spans.length;
        if (exported === expected) {
          resolve();
        } else if (exported > expected) {
          reject(new Error(`exported ${exported} spans, expected ${expected}`));
        }
      });
    },
    forceFlush() {
      return exporter.forceFlush();
    },
    shutdown() {
      return exporter.shutdown();
    },
    async waitForExpectedSpans() {
      if (expected === 0) return;
      let timer;
      try {
        await Promise.race([
          complete,
          new Promise((_, onTimeout) => {
            timer = setTimeout(
              () =>
                onTimeout(
                  new Error(
                    `timed out waiting for Fetch spans: expected ${expected}, exported ${exported}`,
                  ),
                ),
              timeoutMillis,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = { trackingExporter };
