import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError, requireStr, optStr, optInt, optBool, optNumber, requireUrl, optLogLevel,
  loadCommonConfig, loadDbConfig, pgSsl, redactConfig, loadOrExit,
} from "./config.js";

test("requireStr returns a trimmed value", () => {
  assert.equal(requireStr({ A: "  hi  " }, "A"), "hi");
});

test("requireStr throws ConfigError naming the key when missing or blank", () => {
  assert.throws(() => requireStr({}, "GATEWAY_URL"), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.match((err as Error).message, /GATEWAY_URL/);
    return true;
  });
  assert.throws(() => requireStr({ GATEWAY_URL: "   " }, "GATEWAY_URL"), ConfigError);
});

test("optInt returns the default when unset and parses when set", () => {
  assert.equal(optInt({}, "DB_POOL_MAX", 10), 10);
  assert.equal(optInt({ DB_POOL_MAX: "1" }, "DB_POOL_MAX", 10), 1);
});

test("optInt rejects a non-integer and reports the key and the value", () => {
  assert.throws(() => optInt({ DB_POOL_MAX: "ten" }, "DB_POOL_MAX", 10), (err: unknown) => {
    assert.match((err as Error).message, /DB_POOL_MAX/);
    assert.match((err as Error).message, /ten/);
    return true;
  });
  assert.throws(() => optInt({ N: "1.5" }, "N", 1), ConfigError);
});

test("optInt enforces min and max", () => {
  assert.throws(() => optInt({ N: "0" }, "N", 5, { min: 1 }), /must be >= 1/);
  assert.throws(() => optInt({ N: "99999" }, "N", 5, { max: 100 }), /must be <= 100/);
});

test("optBool accepts true/false/1/0 and rejects anything else", () => {
  assert.equal(optBool({ F: "true" }, "F", false), true);
  assert.equal(optBool({ F: "0" }, "F", true), false);
  assert.equal(optBool({}, "F", true), true);
  assert.throws(() => optBool({ F: "yes" }, "F", false), ConfigError);
});

test("requireUrl validates and strips trailing slashes", () => {
  assert.equal(requireUrl({ U: "http://gw:3000/" }, "U"), "http://gw:3000");
  assert.throws(() => requireUrl({ U: "gw:3000" }, "U"), ConfigError);
});

test("optLogLevel rejects an unknown level", () => {
  assert.equal(optLogLevel({}, "LOG_LEVEL", "info"), "info");
  assert.throws(() => optLogLevel({ LOG_LEVEL: "chatty" }, "LOG_LEVEL", "info"), ConfigError);
});

test("loadCommonConfig applies every documented default", () => {
  assert.deepEqual(loadCommonConfig({}), {
    nodeEnv: "production",
    port: 3000,
    logLevel: "info",
    serviceVersion: "dev",
    deploymentEnv: "dev",
    otelEndpoint: null,
    gracefulShutdownMs: 10000,
  });
});

test("loadCommonConfig reads OTEL_EXPORTER_OTLP_ENDPOINT when set", () => {
  const c = loadCommonConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" });
  assert.equal(c.otelEndpoint, "http://otel:4318");
});

test("redactConfig hides a password but keeps the host and database visible", () => {
  const out = redactConfig({
    databaseUrl: "postgres://app:s3cret@db.svc:5432/sample",
    dbPoolMax: 10,
  });
  assert.equal(out.dbPoolMax, 10);
  assert.match(String(out.databaseUrl), /db\.svc:5432\/sample/);
  assert.doesNotMatch(String(out.databaseUrl), /s3cret/);
});

test("redactConfig masks anything named like a secret", () => {
  const out = redactConfig({ apiToken: "abc123", webhookSecret: "xyz" });
  assert.equal(out.apiToken, "***");
  assert.equal(out.webhookSecret, "***");
});

test("redactConfig reaches a password nested inside a group", () => {
  const out = redactConfig({ db: { host: "db.svc", password: "s3cret" } });
  const db = out.db as Record<string, unknown>;
  assert.equal(db.host, "db.svc");
  assert.equal(db.password, "***");
});

test("loadDbConfig applies every documented default", () => {
  const c = loadDbConfig({ DB_HOST: "db.svc", DB_USERNAME: "app", DB_PASSWORD: "pw" });
  assert.deepEqual(c, {
    host: "db.svc",
    port: 5432,
    user: "app",
    password: "pw",
    database: "sample_app",
    sslMode: "disable",
  });
});

test("loadDbConfig requires host, username and password", () => {
  for (const missing of ["DB_HOST", "DB_USERNAME", "DB_PASSWORD"]) {
    const env: Record<string, string> = { DB_HOST: "db.svc", DB_USERNAME: "app", DB_PASSWORD: "pw" };
    delete env[missing];
    assert.throws(() => loadDbConfig(env), new RegExp(missing), `${missing} should be required`);
  }
});

// A typo here is the dangerous case: silently falling back to "disable" gives an unencrypted
// connection the operator believes is encrypted.
test("loadDbConfig rejects an unknown DB_SSL_MODE", () => {
  const base = { DB_HOST: "db.svc", DB_USERNAME: "app", DB_PASSWORD: "pw" };
  assert.throws(() => loadDbConfig({ ...base, DB_SSL_MODE: "required" }), /DB_SSL_MODE/);
  assert.equal(loadDbConfig({ ...base, DB_SSL_MODE: "verify-full" }).sslMode, "verify-full");
});

test("pgSsl maps libpq modes onto node-postgres's ssl option", () => {
  assert.equal(pgSsl("disable"), false);
  assert.deepEqual(pgSsl("require"), { rejectUnauthorized: false });
  assert.deepEqual(pgSsl("verify-ca"), { rejectUnauthorized: true });
  assert.deepEqual(pgSsl("verify-full"), { rejectUnauthorized: true });
});

test("loadOrExit writes the reason to stdout and exits 1 on a bad value", () => {
  const written: string[] = [];
  let code: number | null = null;
  loadOrExit(
    (env) => ({ n: optInt(env, "DB_POOL_MAX", 10) }),
    { DB_POOL_MAX: "ten" },
    { write: (s) => written.push(s), exit: ((c: number) => { code = c; return undefined as never; }) },
  );
  assert.equal(code, 1);
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]!);
  assert.equal(line.level, "error");
  assert.match(line.err.msg, /DB_POOL_MAX/);
});

test("optNumber accepts fractions and enforces its bounds", () => {
  assert.equal(optNumber({}, "RATIO", 0.3), 0.3);
  assert.equal(optNumber({ RATIO: "0.75" }, "RATIO", 0.3), 0.75);
  assert.throws(() => optNumber({ RATIO: "2" }, "RATIO", 0.3, { max: 1 }), /RATIO/);
  assert.throws(() => optNumber({ RATIO: "abc" }, "RATIO", 0.3), /RATIO/);
});