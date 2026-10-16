/**
 * Regression test for the audit fix "exit on unrecoverable MongoDB connect
 * failure": when MongoClient.connect rejects, the process must exit non-zero
 * (so systemd's Restart=always retries) instead of staying up half-alive with
 * this.db === null forever.
 *
 * Coverage: the real entry script (src/main.js, as `npm start` and the image
 * CMD run it) is spawned with all required env vars set except that
 * MONGO_URI points at a closed loopback port, so the driver fails immediately
 * with ECONNREFUSED. The test asserts a bounded-time exit with code 1 and the
 * driver's failure in the log. serverSelectionTimeoutMS=1000 is passed in the
 * URI only to keep the wait short - the driver's 30 s default would exercise
 * the identical code path, just slower.
 *
 * Not covered: the nodemon --exitcrash wrapper (image dev CMD) - that is
 * devDependencies behaviour verifiable in the image, and the systemd restart
 * policy itself, which belongs to the deployment stack.
 */

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A port nothing listens on: the connect attempt gets ECONNREFUSED straight away.
function findRefusedPort() {
  const candidates = [1, 9, 70, 143, 2143];
  const tryOne = (port) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      const finish = (fn, value) => {
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };
      const timer = setTimeout(() => reject(new Error("no refused port among " + candidates)), 1000);
      socket.on("connect", () => finish(reject, new Error("port " + port + " unexpectedly open")));
      socket.on("error", (err) => (err.code === "ECONNREFUSED" ? finish(resolve, port) : finish(reject, err)));
    });
  const attempt = (index) =>
    index >= candidates.length
      ? Promise.reject(new Error("no refused port among " + candidates))
      : tryOne(candidates[index]).catch(() => attempt(index + 1));
  return attempt(0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test("server exits non-zero when MongoDB is unreachable at boot", { timeout: 30000 }, async () => {
  const deadPort = await findRefusedPort();
  const appPort = await freePort();
  const reposPath = fs.mkdtempSync(path.join(os.tmpdir(), "visp-mongodown-repos-"));
  // addLog appends to logs/emu-webapp-server.log relative to cwd
  fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });

  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  env.MONGO_DB_NAME = "visp-test";
  env.MONGO_URI = "mongodb://127.0.0.1:" + deadPort + "/visp-test?serverSelectionTimeoutMS=1000";
  env.REPOSITORIES_PATH = reposPath;
  env.MEDIA_FILE_BASE_URL = "http://127.0.0.1:" + appPort;
  env.WS_SERVER_PORT = String(appPort);

  const child = spawn(process.execPath, ["src/main.js"], { cwd: repoRoot, env });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    let hung = false;
    const killTimer = setTimeout(() => {
      hung = true;
      child.kill("SIGKILL");
    }, 20000);
    const { code, signal } = await exitPromise;
    clearTimeout(killTimer);

    assert.equal(hung, false, "process neither connected nor exited within 20 s - it hung instead of failing fast\noutput:\n" + output);
    assert.equal(signal, null, "process had to be killed, it did not exit on its own (signal=" + signal + ")\noutput:\n" + output);
    assert.equal(code, 1, "expected exit code 1 for an unrecoverable MongoDB connect failure\noutput:\n" + output);
    assert.match(output, /Failed to connect to MongoDB/, "exit was not attributed to the MongoDB failure\noutput:\n" + output);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
    fs.rmSync(reposPath, { recursive: true, force: true });
  }
});
