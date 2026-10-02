// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/**
 * Runs a browser scenario: bundles its page, serves it, and opens it in a
 * headless Chrome the machine already has.
 *
 * The page is served from one origin that also relays its OTLP exports to the
 * endpoint the runner injected and, when the scenario names an upstream, every
 * other request to it. One origin is what lets the page reach both without
 * CORS, which neither the runner's bridge nor the mock server answers.
 *
 * `GET /`, `GET /page.js` and any `POST` under `/v1/` are the origin's own, so
 * a request the page sends to one of those never reaches the upstream.
 */

const http = require("node:http");
const { requireEnv } = require("@otel-conformance/scenario-support");

const SCENARIO_TIMEOUT_MILLIS = 30_000;
const CHANNEL_VARIABLE = "OTEL_CONFORMANCE_BROWSER_CHANNEL";
const HTML =
  '<!doctype html><link rel="icon" href="data:,">' +
  '<script type="module" src="/page.js"></script>';

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * Sends one request on to `base`, with the Content-Length the bridge requires,
 * and notes it in `refused` when it failed or was an export not accepted.
 */
function relay(base, request, body, response, refused, exporting) {
  const target = new URL(request.url, base);
  const headers = { ...request.headers, host: target.host };
  delete headers["transfer-encoding"];
  headers["content-length"] = String(body.length);
  const fail = (error) => {
    refused.push(`${request.url} failed: ${error.message}`);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`${error}\n`);
  };
  const upstream = http.request(
    target,
    { method: request.method, headers },
    (answer) => {
      // An upstream's 4xx and 5xx are traffic the scenario measures.
      if (exporting && answer.statusCode >= 400) {
        refused.push(`${request.url} answered ${answer.statusCode}`);
      }
      answer.on("error", fail);
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", fail);
  upstream.end(body);
}

/** The page's origin: the page, its script, the OTLP relay and the proxy. */
function serve({ script, otlpEndpoint, upstream, refused = [] }) {
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(HTML);
      return;
    }
    if (request.method === "GET" && request.url === "/page.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    const exporting =
      request.method === "POST" && request.url.startsWith("/v1/");
    if (!exporting && !upstream) {
      response.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      refused.push(`${request.url} failed: ${error.message}`);
      response.destroy();
      return;
    }
    const base = exporting ? otlpEndpoint : upstream;
    relay(base, request, body, response, refused, exporting);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function bundle(page) {
  const esbuild = require("esbuild");
  const built = await esbuild.build({
    entryPoints: [page],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  return built.outputFiles[0].contents;
}

function within(promise, millis, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), millis);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Opens `page` (a file exposing `runScenario` through `./page`), calls it
 * with `input`, and returns once its exports have been answered. Any other
 * request the page sends goes to `upstream`, if there is one.
 *
 * Answers with what the page's workload returned, or undefined when the run
 * failed, which has already been reported and set the exit code.
 */
async function runInBrowser({ page, upstream }, input) {
  let server;
  let browser;
  const refused = [];
  try {
    if (requireEnv("OTEL_EXPORTER_OTLP_PROTOCOL") !== "http/protobuf") {
      throw new Error("a browser exports OTLP/HTTP: declare otlp_protocol");
    }
    server = await serve({
      script: await bundle(page),
      otlpEndpoint: requireEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
      upstream,
      refused,
    });
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({
      channel: process.env[CHANNEL_VARIABLE] || "chrome",
    });
    const tab = await browser.newPage();
    tab.on("pageerror", (error) => console.error(error));
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    await tab.waitForFunction(() => typeof runScenario === "function");
    const { result, seen } = await within(
      tab.evaluate((value) => globalThis.runScenario(value), input),
      SCENARIO_TIMEOUT_MILLIS,
      "the page's scenario",
    );
    if (refused.length > 0) {
      throw new Error(`requests were refused: ${refused.join("; ")}`);
    }
    console.log(JSON.stringify(seen));
    return result;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    // The origin first: a page being closed can still emit, and nothing it
    // emits after its scenario returned belongs in the run.
    server?.closeAllConnections();
    server?.close();
    await browser?.close();
  }
}

module.exports = { runInBrowser, serve };
