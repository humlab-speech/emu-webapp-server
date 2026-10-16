/**
 * Regression test for the audit fix "handle 'error' events on client
 * WebSockets" (crash on malformed frames) and its follow-ups on this branch
 * ("attach ws error listener before pre-auth early-return paths", "make the
 * crash guards actually guard").
 *
 * What is covered here, end to end: a real server process is spawned with
 * fake environment variables (Mongo is a TCP sink that accepts connections
 * but never answers, so the driver keeps retrying and the process stays up
 * — no real MongoDB needed), a WebSocket handshake is performed over a raw
 * socket with both auth cookies present so the connection is not closed
 * pre-auth, and then malformed frame bytes are written. Without an 'error'
 * listener on the client WebSocket, ws's receiver ProtocolError rethrows as
 * an uncaught exception and the process dies; the test asserts the process is
 * still alive afterwards. It additionally asserts the server logged
 * "WebSocket connection error", so a vacuous pass (frame never reaching the
 * receiver) fails loudly instead of looking like a fix.
 *
 * Not covered: the message-handling path after authentication (needs a real
 * MongoDB with seeded users/projects collections) and the /file/ HTTP route.
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

// Stands in for MongoDB: completes TCP connects so the driver does not fail
// fast, then stays silent so server selection keeps retrying while the test runs.
function startTcpSink() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.resume();
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOutput(pattern, child, getOutput, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      child.off("exit", onEarlyExit);
      fn();
    };
    const check = () => {
      if (pattern.test(getOutput())) finish(resolve);
    };
    const timer = setInterval(() => {
      check();
      if (!settled && Date.now() > deadline) {
        finish(() => reject(new Error("timed out waiting for " + pattern + "\noutput:\n" + getOutput())));
      }
    }, 100);
    const deadline = Date.now() + timeoutMs;
    const onEarlyExit = (code, signal) => {
      finish(() =>
        reject(
          new Error(
            "server exited early (code=" + code + ", signal=" + signal + ") while waiting for " + pattern + "\noutput:\n" + getOutput(),
          )
        )
      );
    };
    child.on("exit", onEarlyExit);
    check();
  });
}

function websocketHandshake(port, origin, cookieHeader) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error("websocket handshake timed out"));
    });
    socket.on("error", reject);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      const end = data.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.setTimeout(0);
        socket.off("error", reject);
        resolve({ socket, head: data.slice(0, end + 4) });
      }
    });
    socket.write(
      "GET / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + port + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Origin: " + origin + "\r\n" +
        "Cookie: " + cookieHeader + "\r\n" +
        "\r\n"
    );
  });
}

test(
  "server survives malformed websocket frames sent after the handshake",
  { timeout: 45000 },
  async () => {
    const sink = await startTcpSink();
    const appPort = await freePort();
    const reposPath = fs.mkdtempSync(path.join(os.tmpdir(), "visp-ws-repos-"));
    // addLog appends to logs/emu-webapp-server.log relative to cwd
    fs.mkdirSync(path.join(repoRoot, "logs"), { recursive: true });

    const child = spawn(process.execPath, ["src/main.js"], {
      cwd: repoRoot,
      env: (() => {
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        env.MONGO_DB_NAME = "visp-test";
        env.MONGO_URI = "mongodb://127.0.0.1:" + sink.port + "/visp-test?serverSelectionTimeoutMS=60000";
        env.REPOSITORIES_PATH = reposPath;
        env.MEDIA_FILE_BASE_URL = "http://127.0.0.1:" + appPort;
        env.WS_SERVER_PORT = String(appPort);
        return env;
      })(),
    });

    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const getOutput = () => output;

    try {
      await waitForOutput(/is running on port/, child, getOutput, 15000);

      const origin = "http://127.0.0.1:" + appPort;
      const { socket, head } = await websocketHandshake(
        appPort,
        origin,
        "PHPSESSID=test-php-session; projectId=test-project"
      );
      assert.match(head, /^HTTP\/1\.1 101/, "websocket handshake was not accepted:\n" + head);

      // Malformed vectors, all in one write so none can miss the socket window:
      //  0x81 0x00                     - unmasked text frame (clients must mask)
      //  0x83 0x81 mask(4) payload     - masked frame with reserved opcode 0x3
      //  0xFF 0xFE 0x00 0x01           - garbage masquerading as a frame header
      socket.on("error", () => {}); // the server closes with 1002 mid-write: local EPIPE is expected
      socket.write(Buffer.from([0x81, 0x00, 0x83, 0x81, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]));

      await sleep(1200);

      assert.equal(child.exitCode, null, "server died on a malformed frame - the WebSocket 'error' listener is missing or rethrowing\noutput:\n" + output);
      assert.match(
        output,
        /WebSocket connection error/,
        "the malformed frames never reached ws's Receiver - this test would pass vacuously\noutput:\n" + output
      );
      socket.destroy();
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
      sink.close();
      fs.rmSync(reposPath, { recursive: true, force: true });
    }
  }
);
