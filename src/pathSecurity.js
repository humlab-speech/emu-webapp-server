import path from 'path';

/**
 * Path traversal protection for client-supplied values (project ids, session
 * and bundle names, file extensions) that end up in filesystem paths.
 * Mirrors session-manager's pathSecurity.js.
 */

/**
 * Validate that a value is safe to use as (part of) a single path component:
 * a non-empty string without path separators, null bytes or "..".
 * Throws on anything else, returns the value unchanged.
 */
export function safePathComponent(value, label) {
  if(typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new Error(label+" must be a non-empty string of at most 255 characters");
  }
  if(/[/\\\0]/.test(value)) {
    throw new Error(label+" contains a path separator or null byte");
  }
  if(value.includes("..")) {
    throw new Error(label+" contains '..'");
  }
  return value;
}

/**
 * Join segments under root and verify the result does not escape it. Second
 * line of defence in case a component was not validated.
 */
export function safeJoinedPath(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const resolvedFull = path.resolve(resolvedRoot, ...segments);
  if(resolvedFull !== resolvedRoot && !resolvedFull.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Resolved path escapes "+resolvedRoot);
  }
  return resolvedFull;
}
