# HTTP conformance scenarios in JavaScript

HTTP instrumentations for Node and the browser, measured against
[the same contract](../../../tools/http/test-client/contract.yaml) as every
other language.

```text
express/scenarios/                    what the server does, no OTel
express/opentelemetry-express/        server.js, server/
fetch/scenarios/                      what the page sends, no OTel
fetch/opentelemetry-browser-instrumentation/
                                      client.js, browser.js, client/
http/scenarios/                       built-in client and server, no OTel
http/opentelemetry-http/              client.js, server.js, client/, server/
undici/scenarios/                     what the client does, no OTel
undici/opentelemetry-undici/          client.js, client/
xml-http-request/scenarios/           what the page sends, no OTel
xml-http-request/opentelemetry-browser-instrumentation/
                                      client.js, browser.js, client/
```

This directory is the build root: one npm workspace, whose `package.json` and
`package-lock.json` are committed so a run measures pinned versions. It pulls
in the shared packages under [`tools/js`](../../../tools/js) and
[`tools/http/test-client/js`](../../../tools/http/test-client/js) by path rather
than restating them.

A `<library>/scenarios` package is the workload with no OpenTelemetry in it at
all, so a second instrumentation of the same library measures the same
behavior. Each `<instrumentation>` package is only the launch: it registers what
it is measuring and hands the workload over.

Client and server are separate packages even where one library has both, since
coverage reduces everything a package emits and combining them could hide a
client span in a server run.

## Express

The server declares its routes in Express's own routing API, because that
declaration is what an instrumentation reads `http.route` from:

```js
app.get("/health", answer);
app.get("/users/:userId", answer);
app.post("/items", answer);
app.get("/status/:code", answer);
```

Answering is a shared lookup by concrete method and path, so no scenario
restates a status or a response body.

Two instrumentations are registered rather than one:
`@opentelemetry/instrumentation-express` produces `http.route` and a span per
middleware and route handler, but not the server span they hang from — that is
`@opentelemetry/instrumentation-http`'s. The package is named for the one being
measured, and the other is an ordinary dependency of it.

## undici

undici does not go through Node's `http` module, so its client spans come from
`@opentelemetry/instrumentation-undici` alone. The requests go through
`undici.request`, which reports every status rather than throwing on 4xx and
5xx: the contract's failing statuses are traffic to be measured like any other.

## fetch and XMLHttpRequest

The browser's own `fetch` and `XMLHttpRequest`, measured through the `fetch`
and `xhr` modules of `@opentelemetry/browser-instrumentation` in headless
Chrome. `client.js` picks the contract request in Node and hands it to the page
in `browser.js`, which sends it to its own origin, and
[the launcher](../../../tools/js/browser-launcher) proxies it to the mock
server. So `url.full`, `server.address` and `server.port` name that origin
rather than the mock server, and a header the browser controls, such as
`User-Agent`, is the browser's.

## Running one

Use Node 22.19.0 or newer. The lockfile pins `undici@8.10.0`, which requires
that version.

```sh
pip install -e tools/runner -e tools/http/runner -e tools/http/mock-server \
  -e tools/http/test-client/python -e tools/js
otel-conformance scenarios/http/js/express/opentelemetry-express/server
otel-conformance scenarios/http/js/fetch/opentelemetry-browser-instrumentation/client
otel-conformance scenarios/http/js/http/opentelemetry-http/client
otel-conformance scenarios/http/js/http/opentelemetry-http/server
otel-conformance scenarios/http/js/undici/opentelemetry-undici/client
otel-conformance scenarios/http/js/xml-http-request/opentelemetry-browser-instrumentation/client
```

Each package's `setup:` is `otel-conformance-js install`, which installs this
whole workspace from the lockfile. Because the shared packages are installed as
copies rather than links, editing one under `tools/` takes effect on the next
install — which every run performs, so no run measures a stale copy, but an
`npm ci` here is what makes an edit visible to anything else.

The helper's own unit tests and the formatter run from here:

```sh
npm --prefix scenarios/http/js test
npm --prefix scenarios/http/js run format:check
```
