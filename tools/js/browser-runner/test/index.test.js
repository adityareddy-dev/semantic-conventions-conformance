// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { launchBrowser, runBrowserScenario, serve } = require("../index");

const url = (server) => `http://127.0.0.1:${server.address().port}`;
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function scenario(endpoint, options = {}) {
  await withEnvironment(
    {
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    },
    () =>
      runBrowserScenario({
        entrypoint: path.join(__dirname, "fixtures", "export.js"),
        ...options,
      }),
  );
}

test("falls back to Playwright's managed Chromium", async () => {
  const launches = [];
  const managed = { close() {} };
  assert.equal(
    await launchBrowser({
      async launch(options) {
        launches.push(options);
        if (options.channel) throw new Error("Chrome is not installed");
        return managed;
      },
    }),
    managed,
  );
  assert.deepEqual(launches, [
    { channel: "chrome", headless: true },
    { headless: true },
  ]);
});

test("preserves both browser launch failures", async () => {
  const chrome = new Error("Chrome failed");
  const chromium = new Error("Chromium failed");
  await assert.rejects(
    launchBrowser({
      async launch(options) {
        throw options.channel ? chrome : chromium;
      },
    }),
    (error) => {
      assert.deepEqual(error.cause.errors, [chrome, chromium]);
      return true;
    },
  );
});

test("validates protocol and contract URL before launching", async () => {
  await withEnvironment({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, () =>
    assert.rejects(runBrowserScenario({}), /otlp_protocol/),
  );
  await withEnvironment(
    {
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      MOCK_SERVER_URL: "not a URL",
    },
    () =>
      assert.rejects(
        runBrowserScenario({ exchanges: [{}] }),
        /MOCK_SERVER_URL/,
      ),
  );
});

test("relays traces, logs and metrics with their bytes and content type", async () => {
  const received = [];
  const endpoint = await listen(
    http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({
        path: request.url,
        type: request.headers["content-type"],
        body: [...Buffer.concat(chunks)],
      });
      response.end();
    }),
  );
  const refused = [];
  const origin = await serve({
    script: "window.loaded = true",
    otlpEndpoint: url(endpoint),
    refused,
  });
  try {
    assert.match(await (await fetch(url(origin))).text(), /scenario.js/);
    assert.match(
      await (
        await fetch(`${url(origin)}/_otel-conformance/scenario.js`)
      ).text(),
      /window.loaded = true/,
    );
    for (const signal of ["traces", "logs", "metrics"]) {
      assert.equal(
        (
          await fetch(`${url(origin)}/_otel-conformance/v1/${signal}`, {
            method: "POST",
            headers: { "content-type": "application/x-protobuf" },
            body: new Uint8Array([1, 2, 3]),
          })
        ).status,
        200,
      );
    }
    assert.deepEqual(
      received,
      ["traces", "logs", "metrics"].map((signal) => ({
        path: `/v1/${signal}`,
        type: "application/x-protobuf",
        body: [1, 2, 3],
      })),
    );
    assert.deepEqual(refused, []);
  } finally {
    await close(origin);
    await close(endpoint);
  }
});

test("normalizes chunked exports for the runner's Content-Length requirement", async () => {
  let received;
  const endpoint = await listen(
    http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received = {
        length: request.headers["content-length"],
        encoding: request.headers["transfer-encoding"],
        body: [...Buffer.concat(chunks)],
      };
      response.end();
    }),
  );
  const origin = await serve({ script: "", otlpEndpoint: url(endpoint) });
  try {
    await new Promise((resolve, reject) => {
      const request = http.request(
        `${url(origin)}/_otel-conformance/v1/traces`,
        { method: "POST" },
        (response) => {
          response.resume();
          response.on("end", resolve);
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.write(Buffer.from([1]));
      request.end(Buffer.from([2, 3]));
    });
    assert.deepEqual(received, {
      length: "3",
      encoding: undefined,
      body: [1, 2, 3],
    });
  } finally {
    await close(origin);
    await close(endpoint);
  }
});

test("proxies the contract path, query, method, body and response", async () => {
  const mock = await listen(
    http.createServer(async (request, response) => {
      assert.equal(request.url, "/items?verbose=true");
      assert.equal(request.method, "POST");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString(), '{"x":1}');
      response.writeHead(201, { "content-type": "application/json" });
      response.end('{"created":true}');
    }),
  );
  const origin = await serve({
    script: "",
    otlpEndpoint: "http://unused",
    mockServer: url(mock),
  });
  try {
    const answer = await fetch(`${url(origin)}/items?verbose=true`, {
      method: "POST",
      body: '{"x":1}',
    });
    assert.equal(answer.status, 201);
    assert.deepEqual(await answer.json(), { created: true });
  } finally {
    await close(origin);
    await close(mock);
  }
});

test("fails the scenario when an export endpoint is unreachable", async () => {
  const endpoint = await listen(http.createServer());
  const target = url(endpoint);
  await close(endpoint);
  await assert.rejects(scenario(target), /exports were not accepted:.*failed:/);
});

for (const status of [302, 503]) {
  test(`fails the scenario when an export answers ${status}`, async () => {
    const endpoint = await listen(
      http.createServer((_, response) => response.writeHead(status).end()),
    );
    try {
      await assert.rejects(
        scenario(url(endpoint)),
        new RegExp(`exports were not accepted:.*answered ${status}`),
      );
    } finally {
      await close(endpoint);
    }
  });
}

test("fails a stalled export within the scenario deadline", async () => {
  const endpoint = await listen(http.createServer(() => {}));
  try {
    await assert.rejects(
      scenario(url(endpoint), { timeoutMillis: 1000 }),
      /timed out/,
    );
  } finally {
    await close(endpoint);
  }
});

test("reports a top-level browser error", async () => {
  await assert.rejects(
    scenario("http://127.0.0.1:1", {
      entrypoint: path.join(__dirname, "fixtures", "error.js"),
    }),
    /fixture crashed before completion/,
  );
});

test("bounds a workload that never sets its result", async () => {
  await assert.rejects(
    scenario("http://127.0.0.1:1", {
      entrypoint: path.join(__dirname, "fixtures", "pending.js"),
      timeoutMillis: 1000,
    }),
    /timed out|Timeout/,
  );
});
