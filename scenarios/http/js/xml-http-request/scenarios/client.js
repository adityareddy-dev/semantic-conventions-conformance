// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * Sends one contract request with the browser's `XMLHttpRequest`. Runs in the
 * page, which the launcher serves from the origin that proxies to the mock
 * server, so the path alone addresses it.
 *
 * An `XMLHttpRequest` reports every status through `load`, so the contract's
 * 4xx and 5xx answers resolve like any other. Only a request that got no
 * answer at all rejects.
 */

// The contract's CONTENT_TYPE: the page can't read contract.yaml itself.
const CONTENT_TYPE = "application/json";

function send(method, path, body) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, path);
    // Only when there is one to describe, so a GET does not announce a
    // content type for a body it never sent.
    if (body !== null) {
      request.setRequestHeader("content-type", CONTENT_TYPE);
    }
    request.addEventListener("load", () =>
      resolve({ status: request.status, body: request.responseText }),
    );
    request.addEventListener("error", () =>
      reject(new Error(`${method} ${path} got no answer`)),
    );
    request.send(body);
  });
}

module.exports = { send };
