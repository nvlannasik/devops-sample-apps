import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPath, matchRoute, UNMATCHED_ROUTE, type Route } from "./router.js";

const noop = () => {};

test("a literal pattern matches only itself", () => {
  assert.deepEqual(matchPath("/orders", "/orders"), {});
  assert.equal(matchPath("/orders", "/order"), null);
});

test("the root pattern matches the root path", () => {
  assert.deepEqual(matchPath("/", "/"), {});
});

test("a parameter segment captures its value", () => {
  assert.deepEqual(matchPath("/orders/:id", "/orders/018f-abc"), { id: "018f-abc" });
});

test("a parameter never spans a slash", () => {
  assert.equal(matchPath("/orders/:id", "/orders/018f/items"), null);
  assert.equal(matchPath("/orders/:id", "/orders"), null);
});

test("a parameter value is url-decoded", () => {
  assert.deepEqual(matchPath("/assets/:version/app.css", "/assets/a%2Fb/app.css"), { version: "a/b" });
});

test("matchRoute honours the method and returns the first matching route", () => {
  const routes: Route[] = [
    { method: "GET", pattern: "/orders", handler: noop },
    { method: "POST", pattern: "/orders", handler: noop },
    { method: "GET", pattern: "/orders/:id", handler: noop },
  ];
  assert.equal(matchRoute(routes, "POST", "/orders")?.route.pattern, "/orders");
  assert.equal(matchRoute(routes, "GET", "/orders/9")?.route.pattern, "/orders/:id");
  assert.deepEqual(matchRoute(routes, "GET", "/orders/9")?.params, { id: "9" });
  assert.equal(matchRoute(routes, "DELETE", "/orders"), null);
});

test("UNMATCHED_ROUTE is a fixed label so a 404 flood cannot explode cardinality", () => {
  assert.equal(UNMATCHED_ROUTE, "__unmatched__");
});