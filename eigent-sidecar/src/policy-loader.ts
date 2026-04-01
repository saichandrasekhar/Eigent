/**
 * Policy loader for the Eigent sidecar.
 *
 * Loads and validates YAML policy files, and watches for file changes
 * to support hot-reload of policy configuration.
 */

import { readFileSync, watch, type FSWatcher } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PolicyConfig } from "./policy.js";

// ── Zod schema ──────────────────────────────────────────────────────────

const delegationDepthSchema = z.object({
  gt: z.number().int().optional(),
  lt: z.number().int().optional(),
  eq: z.number().int().optional(),
}).strict();

const timeWindowSchema = z.object({
  after: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional(),
  before: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format").optional(),
  days: z.array(z.string().regex(/^(mon|tue|wed|thu|fri|sat|sun)$/i, "Day must be mon-sun")).optional(),
}).strict();

const matchSchema = z.object({
  tool: z.union([z.string(), z.array(z.string())]).optional(),
  agent_id: z.union([z.string(), z.array(z.string()), z.null()]).optional(),
  human_email: z.union([z.string(), z.array(z.string())]).optional(),
  delegation_depth: delegationDepthSchema.optional(),
  time_window: timeWindowSchema.optional(),
  arguments: z.record(z.string(), z.string()).optional(),
}).strict();

const policyRuleSchema = z.object({
  name: z.string().min(1, "Rule name is required"),
  description: z.string().optional(),
  match: matchSchema,
  action: z.enum(["allow", "deny", "log", "require_approval"]),
  reason: z.string().optional(),
  priority: z.number().int().optional(),
}).strict();

const policyConfigSchema = z.object({
  version: z.literal("1"),
  default_action: z.enum(["allow", "deny"]),
  rules: z.array(policyRuleSchema),
}).strict();

// ── Loader functions ────────────────────────────────────────────────────

/**
 * Load and validate a YAML policy file.
 *
 * @throws Error if the file cannot be read or the schema is invalid.
 */
export function loadPolicy(path: string): PolicyConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed: unknown = parseYaml(raw);

  const result = policyConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid policy file ${path}:\n${issues}`);
  }

  return result.data as PolicyConfig;
}

/**
 * Watch a policy file for changes and invoke the callback on each reload.
 *
 * Returns a cleanup function that stops watching.
 */
export function watchPolicy(
  path: string,
  callback: (config: PolicyConfig | null, error?: Error) => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  try {
    watcher = watch(path, (_eventType) => {
      // Debounce: editors often write files in multiple steps
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          const config = loadPolicy(path);
          callback(config);
        } catch (err) {
          callback(null, err instanceof Error ? err : new Error(String(err)));
        }
      }, 100);
    });
  } catch (err) {
    callback(null, err instanceof Error ? err : new Error(String(err)));
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
  };
}

// Re-export the Zod schema for external validation use
export { policyConfigSchema };
