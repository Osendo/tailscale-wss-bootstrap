/**
 * Integration tests: TailscaleManager + fake Tailscale binaries.
 * No child_process mocking — actual processes are spawned.
 * Tests the sidecar lifecycle: daemon start/stop, auth, serve, status,
 * and the OpenClaw plugin gateway:startup hook.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFile, chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TailscaleManager } from "./manager.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

async function setupFakeBinaries(dir: string): Promise<void> {
  await copyFile(join(fixturesDir, "tailscale"), join(dir, "tailscale"));
  await copyFile(join(fixturesDir, "tailscaled"), join(dir, "tailscaled"));
  await chmod(join(dir, "tailscale"), 0o755);
  await chmod(join(dir, "tailscaled"), 0o755);
}

async function buildManager(dir: string): Promise<TailscaleManager> {
  await setupFakeBinaries(dir);
  return new TailscaleManager(dir);
}

// ── Domain logic tests ──────────────────────────────────────────────────────

describe("TailscaleManager integration", () => {
  let tmpDir: string;
  let mgr: TailscaleManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ts-integration-"));
    mgr = await buildManager(tmpDir);
  });

  afterEach(async () => {
    await mgr.stopDaemon().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("startDaemon spawns fake daemon and socket becomes ready", async () => {
    await mgr.startDaemon();
    expect(await mgr.isSocketResponding()).toBe(true);
  });

  it("ensure with auth key logs in and returns success lines", async () => {
    const lines = await mgr.ensure("tskey-auth-test");
    expect(lines.some((l) => l.includes("Tailscale is up!"))).toBe(true);
  });

  it("status includes socket_responding line", async () => {
    await mgr.startDaemon();
    await writeFile(join(tmpDir, ".ts-auth"), "key");

    const lines = await mgr.status();
    expect(lines.some((l) => l === "socket_responding: yes")).toBe(true);
  });
});

// ── Plugin hook tests ───────────────────────────────────────────────────────

async function runStartup(
  tmpDir: string,
  gatewayPort?: number,
  authKey?: string,
): Promise<string[]> {
  const pluginModule = (await import("../index.js")) as any;
  const plugin = pluginModule.default;
  const messages: string[] = [];
  const mockApi = {
    config: { gateway: { port: gatewayPort } },
    pluginConfig: { stateDir: tmpDir, authKey: authKey ?? "test-key" },
    on: vi.fn(),
    registerHook: vi.fn(),
    registerTool: vi.fn(),
  };

  await plugin.register(mockApi);

  const calls = (mockApi.on as ReturnType<typeof vi.fn>).mock.calls;
  const startupCall = calls.find(call => call[0] === "gateway_start");
  if (!startupCall) throw new Error("gateway_start hook not registered via api.on");

  const handler = startupCall[1];
  await handler({ messages, port: gatewayPort ?? 0 });

  return messages;
}

describe("plugin gateway:startup hook", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ts-plugin-"));
    await setupFakeBinaries(tmpDir);
    await writeFile(join(tmpDir, ".ts-auth"), "existing-key");
  });

  afterEach(async () => {
    const mgr = new TailscaleManager(tmpDir);
    await mgr.stopDaemon().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends OK message when Tailscale is successfully started", async () => {
    process.env.TAILSCALE_AUTH_KEY = "tskey-auth-test";
    const messages = await runStartup(tmpDir);
    expect(messages.some((m) => m.includes("Tailscale is up!")
      || m.includes("tailscale: OK")
      || m.includes("Tailscale state is reusable"))).toBe(true);
    delete process.env.TAILSCALE_AUTH_KEY;
  });

  it("reports error when ensure fails (no auth, no prior state)", async () => {
      await rm(join(tmpDir, ".ts-auth"), { force: true });
      delete process.env.TAILSCALE_AUTH_KEY;
      const messages = await runStartup(tmpDir);
      expect(messages.some((m) => m.includes("tailscale failed"))).toBe(true);
  });
});
