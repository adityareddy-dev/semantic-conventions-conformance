// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * The page: registers the `xhr` module of
 * @opentelemetry/browser-instrumentation and hands the shared workload to the
 * launcher. One request makes one span.
 */

const {
  XhrInstrumentation,
} = require("@opentelemetry/browser-instrumentation/experimental/xhr");
const { exposeScenario } = require("@otel-conformance/browser-launcher/page");
const { send } = require("@otel-conformance/xml-http-request-scenarios");

exposeScenario(
  { instrumentations: [new XhrInstrumentation()], spans: 1 },
  ({ method, path, body }) => send(method, path, body),
);
