// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

const { isJsonEqual } = require("./json-equal");

const CONTENT_TYPE = "application/json";

/** An exchange's response body with the request body inserted. */
function renderResponseBody(exchange, requestBody) {
  // A function rather than the body itself: a string replacement reads `$&`
  // and its siblings as substitution patterns, so a body carrying one would
  // not be echoed literally.
  return exchange.responseBody.replace("${requestBody}", () =>
    requestBody ? requestBody : "{}",
  );
}

/** Checks one answer against the exchange that describes it. */
function verify(exchange, response) {
  const where = `${exchange.method} ${exchange.path}`;
  if (response.status !== exchange.status) {
    throw new Error(
      `${where} answered ${response.status}, but the contract's request ` +
        `answers ${exchange.status}`,
    );
  }

  // Parsed, not compared as text: whitespace and key order are a language's
  // choice of JSON writer, and neither is part of the contract.
  const expected = JSON.parse(renderResponseBody(exchange, exchange.body));
  let actual;
  try {
    actual = JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${where} answered invalid JSON`, { cause: error });
  }
  if (!isJsonEqual(actual, expected)) {
    throw new Error(
      `${where} answered ${JSON.stringify(actual)}, but the contract's ` +
        `request answers ${JSON.stringify(expected)}`,
    );
  }
}

module.exports = { CONTENT_TYPE, renderResponseBody, verify };
