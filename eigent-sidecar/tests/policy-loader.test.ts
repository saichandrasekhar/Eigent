import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadPolicy, watchPolicy } from "../src/policy-loader.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eigent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tmpDirs.length = 0;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("loadPolicy", () => {
  it("loads a valid YAML policy file", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - name: block-write
    match:
      tool: write_file
    action: deny
    reason: "No writes allowed"
    priority: 100
`);

    const config = loadPolicy(filePath);
    expect(config.version).toBe("1");
    expect(config.default_action).toBe("allow");
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].name).toBe("block-write");
    expect(config.rules[0].action).toBe("deny");
    expect(config.rules[0].priority).toBe(100);
  });

  it("throws on invalid version", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "2"
default_action: allow
rules: []
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("throws on invalid default_action", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: maybe
rules: []
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("throws on missing rule name", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - match:
      tool: write_file
    action: deny
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("throws on invalid action value", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - name: bad-action
    match:
      tool: write_file
    action: explode
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("throws on file not found", () => {
    expect(() => loadPolicy("/nonexistent/path/policy.yaml")).toThrow();
  });

  it("validates time_window format", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - name: bad-time
    match:
      time_window:
        before: "not-a-time"
    action: log
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("validates day names", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - name: bad-day
    match:
      time_window:
        days: ["monday"]
    action: log
`);

    expect(() => loadPolicy(filePath)).toThrow("Invalid policy file");
  });

  it("loads a complex policy with multiple rules", () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: deny
rules:
  - name: allow-reads
    match:
      tool: read_file
    action: allow
    priority: 10
  - name: block-system-writes
    match:
      tool: write_file
      arguments:
        path: "^/etc/.*"
    action: deny
    reason: "System write blocked"
    priority: 100
  - name: no-anonymous
    match:
      agent_id: null
    action: deny
    priority: 200
  - name: business-hours
    match:
      time_window:
        before: "08:00"
        after: "18:00"
        days: ["mon", "tue", "wed", "thu", "fri"]
    action: log
  - name: require-approval-deploys
    match:
      tool: deploy_production
    action: require_approval
    reason: "Production deploys need approval"
`);

    const config = loadPolicy(filePath);
    expect(config.rules).toHaveLength(5);
    expect(config.default_action).toBe("deny");
  });
});

describe("watchPolicy", () => {
  it("calls callback when the file changes", async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules:
  - name: rule-v1
    match:
      tool: read_file
    action: allow
`);

    const results: Array<{ config: unknown; error?: Error }> = [];

    const stop = watchPolicy(filePath, (config, error) => {
      results.push({ config, error });
    });

    // Wait a bit, then modify the file
    await new Promise((resolve) => setTimeout(resolve, 200));

    writeFileSync(filePath, `
version: "1"
default_action: deny
rules:
  - name: rule-v2
    match:
      tool: write_file
    action: deny
`);

    // Wait for the debounce + fs event
    await new Promise((resolve) => setTimeout(resolve, 500));

    stop();

    // Should have received at least one callback
    expect(results.length).toBeGreaterThanOrEqual(1);
    const lastResult = results[results.length - 1];
    expect(lastResult.error).toBeUndefined();
    expect(lastResult.config).not.toBeNull();
  });

  it("reports errors for invalid YAML on change", async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const filePath = join(dir, "policy.yaml");

    writeFileSync(filePath, `
version: "1"
default_action: allow
rules: []
`);

    const results: Array<{ config: unknown; error?: Error }> = [];

    const stop = watchPolicy(filePath, (config, error) => {
      results.push({ config, error });
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Write invalid content
    writeFileSync(filePath, `
version: "999"
default_action: invalid
rules: not-an-array
`);

    await new Promise((resolve) => setTimeout(resolve, 500));

    stop();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const lastResult = results[results.length - 1];
    expect(lastResult.error).toBeDefined();
    expect(lastResult.config).toBeNull();
  });
});
