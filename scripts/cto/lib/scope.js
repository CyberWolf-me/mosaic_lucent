/**
 * Path-scope enforcement (spec sections 5, 6.3). Task scopes are glob
 * patterns matched against repo-relative POSIX paths. Implemented without
 * dependencies: supports `**`, `*`, `?` — the shapes used in tasks.json.
 */

/** Convert one glob pattern to a RegExp testing the whole path. */
export function globToRegExp(pattern) {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more directories; trailing `/**` anything.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${re}$`);
}

/** True when path matches at least one pattern in the list. */
export function matchesAny(path, patterns) {
  const posix = path.replace(/\\/g, "/");
  return (patterns ?? []).some((p) => globToRegExp(p).test(posix));
}

/**
 * Scope verdict for a set of changed repo-relative paths.
 * Prohibited wins over allowed: a path matching both is a violation.
 * @returns {{ok: boolean, violations: string[]}}
 */
export function checkScope(task, changedPaths) {
  const violations = [];
  for (const p of changedPaths) {
    if (matchesAny(p, task.scope?.prohibited_paths)) {
      violations.push(`${p}: matches prohibited_paths`);
    } else if (!matchesAny(p, task.scope?.allowed_paths)) {
      violations.push(`${p}: outside allowed_paths`);
    }
  }
  return { ok: violations.length === 0, violations };
}
