// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

/** Serves a browser workload, its OTLP relay, and the HTTP contract proxy. */
const http = require("node:http");
const https = require("node:https");
const { chromium } = require("@playwright/test");
const esbuild = require("esbuild");

const BRIDGE_PATH = "/_otel-conformance";
const SCENARIO_TIMEOUT_MILLIS = 30_000;

function requireUrl(name) {
  try {
    const url = new URL(process.env[name]);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("expected HTTP or HTTPS");
    return url;
  } catch (error) {
    throw new Error(
      `required environment variable is not an HTTP URL: ${name}`,
      { cause: error },
    );
  }
}

async function read(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function proxy(request, response, target, { body, refused, timeoutMillis }) {
  const headers = { ...request.headers, host: target.host };
  if (body !== undefined) {
    delete headers["transfer-encoding"];
    headers["content-length"] = String(body.length);
  }
  const fail = (error) => {
    refused?.push(`${request.url} failed: ${error.message}`);
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(error.message);
    }
  };
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, {
    method: request.method,
    headers,
  });
  upstream.setTimeout(timeoutMillis, () =>
    upstream.destroy(new Error("upstream request timed out")),
  );
  upstream.on("response", (answer) => {
    if (answer.statusCode < 200 || answer.statusCode >= 300)
      refused?.push(`${request.url} answered ${answer.statusCode}`);
    answer.on("error", fail);
    response.writeHead(answer.statusCode, answer.headers);
    answer.pipe(response);
  });
  upstream.on("error", fail);
  response.on("close", () => upstream.destroy());
  if (body === undefined) request.pipe(upstream);
  else upstream.end(body);
}

/** The runner's HTTP bridge owns protobuf-to-gRPC forwarding. */
async function serve({
  script,
  otlpEndpoint,
  mockServer,
  exchanges = [],
  refused = [],
  timeoutMillis = SCENARIO_TIMEOUT_MILLIS,
}) {
  let baseUrl;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><link rel="icon" href="data:,"><script src="${BRIDGE_PATH}/scenario.js"></script>`,
        );
      } else if (
        request.method === "GET" &&
        request.url === `${BRIDGE_PATH}/scenario.js`
      ) {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(
          `window.__otelConformance = ${JSON.stringify({
            baseUrl,
            traceExporterUrl: `${baseUrl}${BRIDGE_PATH}/v1/traces`,
            logExporterUrl: `${baseUrl}${BRIDGE_PATH}/v1/logs`,
            metricExporterUrl: `${baseUrl}${BRIDGE_PATH}/v1/metrics`,
            exchanges,
          })};\n${script}`,
        );
      } else if (
        request.method === "POST" &&
        [
          `${BRIDGE_PATH}/v1/traces`,
          `${BRIDGE_PATH}/v1/logs`,
          `${BRIDGE_PATH}/v1/metrics`,
        ].includes(request.url)
      ) {
        proxy(
          request,
          response,
          new URL(request.url.slice(BRIDGE_PATH.length), otlpEndpoint),
          { body: await read(request), refused, timeoutMillis },
        );
      } else if (mockServer) {
        proxy(request, response, new URL(request.url, mockServer), {
          timeoutMillis,
        });
      } else response.writeHead(404).end();
    } catch (error) {
      refused.push(`${request.url} failed: ${error.message}`);
      response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return server;
}

/** Prefer a locally installed Chrome, then Playwright's managed Chromium. */
async function launchBrowser(browserType = chromium) {
  try {
    return await browserType.launch({ channel: "chrome", headless: true });
  } catch (chromeError) {
    try {
      return await browserType.launch({ headless: true });
    } catch (error) {
      throw new Error("could not launch Chrome or Chromium", {
        cause: new AggregateError([chromeError, error]),
      });
    }
  }
}

async function bundle(entrypoint) {
  const result = await esbuild.build({
    bundle: true,
    entryPoints: [entrypoint],
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  return result.outputFiles[0].text;
}

function within(promise, millis) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `browser scenario timed out after ${millis} ms before completion`,
          ),
        ),
      millis,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs a bundled workload and rejects even exports the page silently ignores. */
async function runBrowserScenario({
  entrypoint,
  exchanges = [],
  timeoutMillis = SCENARIO_TIMEOUT_MILLIS,
}) {
  if (process.env.OTEL_EXPORTER_OTLP_PROTOCOL !== "http/protobuf")
    throw new Error(
      "a browser exports OTLP/HTTP: declare otlp_protocol: http/protobuf",
    );
  const mockServer = exchanges.length
    ? requireUrl("MOCK_SERVER_URL")
    : undefined;
  const otlpEndpoint = requireUrl("OTEL_EXPORTER_OTLP_ENDPOINT");
  const refused = [];
  let server;
  let browser;
  try {
    server = await serve({
      script: await bundle(entrypoint),
      otlpEndpoint,
      mockServer,
      exchanges,
      refused,
      timeoutMillis,
    });
    browser = await launchBrowser();
    const page = await browser.newPage();
    const pageError = new Promise((_, reject) => page.on("pageerror", reject));
    page.on("console", (message) =>
      console.error(`[browser ${message.type()}] ${message.text()}`),
    );
    const workload = async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/`, {
        timeout: timeoutMillis,
      });
      await page.waitForFunction(
        () => window.__otelConformanceResult !== undefined,
        null,
        { timeout: timeoutMillis },
      );
      return page.evaluate(() => window.__otelConformanceResult);
    };
    const result = await within(
      Promise.race([workload(), pageError]),
      timeoutMillis,
    );
    if (refused.length)
      throw new Error(`exports were not accepted: ${refused.join("; ")}`);
    if (!result.ok) throw new Error(result.error);
  } finally {
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    await browser?.close();
  }
}

module.exports = { launchBrowser, runBrowserScenario, serve };
