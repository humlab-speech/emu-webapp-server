/**
 * Tests for src/pathSecurity.js — path traversal protection.
 *
 * Ported from session-manager's test/pathSecurity.test.js, keeping the same
 * attack vectors so the two suites stay in sync across the repos (this module
 * mirrors session-manager's pathSecurity.js). Differences found while porting
 * are documented at the affected vectors and reported; neither implementation
 * was changed to match the other.
 *
 * Adaptations for this repo:
 *   - ES module imports instead of CommonJS require (package.json "type": "module").
 *   - node:test / node:assert instead of the hand-rolled counter harness, so the
 *     suite runs under `node --test test/`.
 *   - session-manager also exports safeMountSource(); this repo has no such
 *     helper (it only serves files, never builds container mounts), so those
 *     vectors are exercised directly against safeJoinedPath, which is exactly
 *     what session-manager's safeMountSource delegates to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { safePathComponent, safeJoinedPath } from "../src/pathSecurity.js";

// ============================================================
// safePathComponent — valid components
// ============================================================

test("safePathComponent accepts alphanumeric", () => {
  assert.doesNotThrow(() => safePathComponent("abc123", "test"));
});

test("safePathComponent accepts hyphens", () => {
  assert.doesNotThrow(() => safePathComponent("some-project-id", "test"));
});

test("safePathComponent accepts slugified eppn", () => {
  assert.doesNotThrow(() => safePathComponent("user_at_uni_dot_se", "test"));
});

test("safePathComponent accepts nanoid-style id", () => {
  assert.doesNotThrow(() => safePathComponent("XkZ9q2mB", "test"));
});

test("safePathComponent accepts spaces and parens", () => {
  assert.doesNotThrow(() => safePathComponent("My Project (1)", "test"));
});

test("safePathComponent accepts filename with dot", () => {
  assert.doesNotThrow(() => safePathComponent("recording.wav", "test"));
});

// ============================================================
// safePathComponent — traversal attempts and invalid input
// ============================================================

test("safePathComponent rejects ../etc/passwd", () => {
  assert.throws(() => safePathComponent("../etc/passwd", "test"));
});

test("safePathComponent rejects ..\\windows\\system32", () => {
  assert.throws(() => safePathComponent("..\\windows\\system32", "test"));
});

test("safePathComponent rejects bare ..", () => {
  assert.throws(() => safePathComponent("..", "test"));
});

// Divergence from session-manager: that implementation rejects "." with an
// explicit `component === "."` check; this one only rejects a literal ".."
// substring, so a bare "." passes here. Reported, not changed: a lone "." is
// still caught by safeJoinedPath's root-containment check if it reaches a join.
test("safePathComponent accepts bare . (diverges from session-manager)", () => {
  assert.doesNotThrow(() => safePathComponent(".", "test"));
});

test("safePathComponent rejects embedded ..", () => {
  assert.throws(() => safePathComponent("foo/../bar", "test"));
});

test("safePathComponent rejects forward slash", () => {
  assert.throws(() => safePathComponent("foo/bar", "test"));
});

test("safePathComponent rejects backslash", () => {
  assert.throws(() => safePathComponent("foo\\bar", "test"));
});

test("safePathComponent rejects null byte", () => {
  assert.throws(() => safePathComponent("foo\0bar", "test"));
});

test("safePathComponent rejects empty string", () => {
  assert.throws(() => safePathComponent("", "test"));
});

// This repo additionally caps component length at 255 characters; session-manager
// has no length cap. Reported as a divergence, vector kept in sync forward.
test("safePathComponent rejects over-long string (>255 chars)", () => {
  assert.throws(() => safePathComponent("a".repeat(256), "test"));
});

test("safePathComponent rejects non-string (number)", () => {
  assert.throws(() => safePathComponent(123, "test"));
});

test("safePathComponent rejects null", () => {
  assert.throws(() => safePathComponent(null, "test"));
});

test("safePathComponent rejects undefined", () => {
  assert.throws(() => safePathComponent(undefined, "test"));
});

// ============================================================
// safeJoinedPath
// ============================================================

test("safeJoinedPath joins simply", () => {
  assert.equal(safeJoinedPath("/repositories", "abc123"), "/repositories/abc123");
});

test("safeJoinedPath joins multiple segments", () => {
  assert.equal(
    safeJoinedPath("/repositories", "abc123", "Data", "VISP_emuDB"),
    "/repositories/abc123/Data/VISP_emuDB"
  );
});

test("safeJoinedPath accepts valid root + component", () => {
  assert.doesNotThrow(() => safeJoinedPath("/repositories", "abc123"));
});

test("safeJoinedPath rejects root + ..", () => {
  assert.throws(() => safeJoinedPath("/repositories", ".."));
});

test("safeJoinedPath rejects root + ../etc/passwd", () => {
  assert.throws(() => safeJoinedPath("/repositories", "..", "etc", "passwd"));
});

test("safeJoinedPath rejects deep traversal back out", () => {
  assert.throws(() => safeJoinedPath("/repositories", "abc123", "..", "..", "etc"));
});

test("safeJoinedPath rejects traversal in single segment", () => {
  assert.throws(() => safeJoinedPath("/repositories", "abc/../../../etc/passwd"));
});

test("safeJoinedPath resolves root-only to root", () => {
  assert.equal(safeJoinedPath("/repositories"), "/repositories");
});

// ============================================================
// Mount-source style checks
// (session-manager wraps these in safeMountSource(); this repo has no such
// export, so the vectors run against the safeJoinedPath it delegates to)
// ============================================================

const fakeRoot = "/home/user/Projects/visible-speech-deployment";

test("safeJoinedPath accepts valid mount source", () => {
  assert.equal(
    safeJoinedPath(fakeRoot, "mounts/repositories/abc123"),
    fakeRoot + "/mounts/repositories/abc123"
  );
});

test("safeJoinedPath accepts valid upload mount source", () => {
  assert.equal(
    safeJoinedPath(fakeRoot, "mounts/apache/apache/uploads/user_at_uni/ctx123"),
    fakeRoot + "/mounts/apache/apache/uploads/user_at_uni/ctx123"
  );
});

test("safeJoinedPath rejects mount traversal", () => {
  assert.throws(() => safeJoinedPath(fakeRoot, "../../etc/passwd"));
});

test("safeJoinedPath rejects mount traversal via nested ..", () => {
  assert.throws(() => safeJoinedPath(fakeRoot, "mounts/repositories/../../.."));
});

// ============================================================
// Integration-style tests (simulating real call patterns)
// ============================================================

test("malicious projectId blocked at component level", () => {
  const projectId = "../../../etc";
  assert.throws(() => {
    safePathComponent(projectId, "projectId");
    safeJoinedPath("/repositories", projectId);
  });
});

test("malicious formContextId blocked", () => {
  const username = "normal_user";
  const context = "../../secrets";
  safePathComponent(username, "username");
  assert.throws(() => safePathComponent(context, "formContextId"));
});

test("malicious sessionName blocked", () => {
  const sessionName = "../../passwords";
  assert.throws(() => safePathComponent(sessionName, "sessionName"));
});

test("typical real-world values pass all checks", () => {
  assert.doesNotThrow(() => {
    const projectId = "V1StGXR8_Z5jdHi6B-myT";
    const sessionId = "kL7mNp2qR9";
    const username = "user_at_uni_dot_se";
    const formContextId = "Xk2mB_nQ9R";
    safePathComponent(projectId, "projectId");
    safePathComponent(sessionId, "sessionId");
    safePathComponent(username, "username");
    safePathComponent(formContextId, "formContextId");
    safeJoinedPath("/repositories", projectId);
    safeJoinedPath(fakeRoot, "mounts/repositories/" + projectId);
    safeJoinedPath(fakeRoot, "mounts/apache/apache/uploads/" + username + "/" + formContextId);
  });
});
