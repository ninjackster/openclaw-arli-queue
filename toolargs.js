// Some models (seen with GLM 4.6 Derestricted on Arli) start string tool
// arguments with stray newlines. A path like "\n\n/Users/me/file" is then read
// as relative and resolves inside the agent workspace, so the tool fails.
// This cleans path-like arguments before the tool runs.

const PATH_KEYS = new Set([
  "path", "file_path", "filepath", "file", "cwd", "workdir", "dir", "directory",
  "old_path", "new_path", "source", "destination", "target_file",
]);

/** Returns a cleaned copy of params, or undefined when nothing changed. */
export function cleanToolParams(toolName, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  let changed = false;
  const out = { ...params };
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;
    let next = value;
    if (PATH_KEYS.has(key.toLowerCase())) {
      next = value.trim();
    } else if (toolName === "apply_patch" && (key === "input" || key === "patch")) {
      next = value.replace(/^\s+/, "");
    }
    if (next !== value) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? out : undefined;
}
