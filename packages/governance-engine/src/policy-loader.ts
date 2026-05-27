import { readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { PolicySchema, type Policy } from "@auzaar/core";

export function loadPolicyFile(filePath: string): Policy {
  const raw = readFileSync(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();

  let parsed: unknown;
  if (ext === ".yaml" || ext === ".yml") {
    parsed = parseYaml(raw);
  } else if (ext === ".json") {
    parsed = JSON.parse(raw);
  } else {
    throw new Error(`Unsupported policy file format: ${ext}`);
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid policy in ${filePath}: ${issues}`);
  }

  return result.data;
}

export function loadPoliciesFromDirectory(dirPath: string): Policy[] {
  const files = readdirSync(dirPath).filter((f) => {
    const ext = extname(f).toLowerCase();
    return ext === ".yaml" || ext === ".yml" || ext === ".json";
  });

  const policies: Policy[] = [];
  for (const file of files) {
    policies.push(loadPolicyFile(join(dirPath, file)));
  }

  return policies.sort((a, b) => b.priority - a.priority);
}

export function watchPolicies(
  dirPath: string,
  onReload: (policies: Policy[]) => void
): FSWatcher {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(dirPath, (_eventType, filename) => {
    if (!filename) return;
    const ext = extname(filename).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const policies = loadPoliciesFromDirectory(dirPath);
        onReload(policies);
      } catch (e: unknown) {
        // SEC-11: Log a structured error so operators know their policy change
        // failed to apply, rather than silently keeping the last valid policies.
        const reason = e instanceof Error ? e.message : String(e);
        console.error(
          JSON.stringify({
            level: "error",
            event: "policy_reload_failed",
            path: dirPath,
            reason,
          })
        );
      }
    }, 100);
  });

  return watcher;
}
