// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * The page: registers the `fetch` module of
 * @opentelemetry/browser-instrumentation and hands the shared workload to the
 * launcher. One request makes one span.
 */

const {
  FetchInstrumentation,
} = require("@opentelemetry/browser-instrumentation/experimental/fetch");
const { exposeScenario } = require("@otel-conformance/browser-launcher/page");
const { send } = require("@otel-conformance/fetch-scenarios");

exposeScenario(
  { instrumentations: [new FetchInstrumentation()], spans: 1 },
  ({ method, path, body }) => send(method, path, body),
);
