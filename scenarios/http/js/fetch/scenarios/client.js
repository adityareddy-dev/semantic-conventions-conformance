// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * Sends one contract request with the browser's own `fetch`. Runs in the
 * page, which the launcher serves from the origin that proxies to the mock
 * server, so the path alone addresses it.
 *
 * `fetch` is looked up on each call rather than kept, so the request goes
 * through whatever an instrumentation installed after this was loaded.
 */

// The contract's CONTENT_TYPE: the page can't read contract.yaml itself.
const CONTENT_TYPE = "application/json";

async function send(method, path, body) {
  const response = await fetch(path, {
    method,
    // Only when there is one to describe, so a GET does not announce a
    // content type for a body it never sent.
    ...(body === null
      ? {}
      : { body, headers: { "content-type": CONTENT_TYPE } }),
  });
  return { status: response.status, body: await response.text() };
}

module.exports = { send };
