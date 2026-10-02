// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * The browser XMLHttpRequest client scenario. Node picks the contract
 * request and hands it to the page in `browser.js`, which sends it from
 * headless Chrome.
 */

const { scenarioRequest } = require("@otel-conformance/http-test-client");
const { runInBrowser } = require("@otel-conformance/browser-launcher");
const { requireEnv } = require("@otel-conformance/scenario-support");

const { method, path, body } = scenarioRequest();
runInBrowser(
  {
    page: require.resolve("./browser.js"),
    upstream: requireEnv("MOCK_SERVER_URL"),
  },
  { method, path, body },
).then((response) => {
  // Logged the way drive() logs a Node client's answer. Undefined on failure.
  if (response) {
    const shown = response.body.replace(/[\r\n]/g, " ").slice(0, 60);
    console.log(`${method} ${path} -> ${response.status} ${shown}`);
  }
});
