/**
 * Integration tests: TailscaleManager + fake Tailscale binaries.
 * No child_process mocking — actual processes are spawned.
 * Tests the sidecar lifecycle: daemon start/stop, auth, serve, status,
 * and the OpenClaw plugin gateway:startup hook.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { copyFile, chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createServer, type Server } from "net";
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

interface LogCapture {
  info: string[];
  warn: string[];
  error: string[];
}

async function runStartup(
  tmpDir: string,
  gatewayPort?: number,
  authKey?: string,
  servePort?: number,
): Promise<LogCapture> {
  const pluginModule = (await import("../index.js")) as any;
  const plugin = pluginModule.default;
  const logs: LogCapture = { info: [], warn: [], error: [] };
  const mockApi = {
    config: { gateway: { port: gatewayPort } },
    pluginConfig: {
      stateDir: tmpDir,
      authKey: authKey ?? "test-key",
      ...(servePort !== undefined && { servePort }),
    },
    logger: {
      info: (msg: string) => logs.info.push(msg),
      warn: (msg: string) => logs.warn.push(msg),
      error: (msg: string) => logs.error.push(msg),
    },
    on: vi.fn(),
    registerHook: vi.fn(),
    registerTool: vi.fn(),
    registerService: vi.fn(),
  };

  await plugin.register(mockApi);

  const calls = (mockApi.on as ReturnType<typeof vi.fn>).mock.calls;
  const startupCall = calls.find(call => call[0] === "gateway_start");
  if (!startupCall) throw new Error("gateway_start hook not registered via api.on");

  const handler = startupCall[1];
  await handler({ port: gatewayPort ?? 0 });

  return logs;
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

  it("logs success when Tailscale is already authenticated", async () => {
    process.env.TAILSCALE_AUTH_KEY = "tskey-auth-test";
    const logs = await runStartup(tmpDir);
    expect(logs.info.some((m) => m.includes("tailscale:"))).toBe(true);
    delete process.env.TAILSCALE_AUTH_KEY;
  });

  it("logs error when ensure fails (no auth, no prior state)", async () => {
    await rm(join(tmpDir, ".ts-auth"), { force: true });
    delete process.env.TAILSCALE_AUTH_KEY;
    const logs = await runStartup(tmpDir);
    expect(logs.error.some((m) => m.includes("tailscale failed"))).toBe(true);
  });
});

// ── servePort configuration tests ───────────────────────────────────────────

describe("plugin servePort config", () => {
  let tmpDir: string;
  let listener: Server;
  let occupiedPort: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ts-plugin-"));
    await setupFakeBinaries(tmpDir);
    await writeFile(join(tmpDir, ".ts-auth"), "existing-key");

    // Occupy a port to simulate a running gateway
    listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, resolve));
    occupiedPort = (listener.address() as any).port;
  });

  afterEach(async () => {
    listener.close();
    const mgr = new TailscaleManager(tmpDir);
    await mgr.stopDaemon().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("uses custom servePort instead of gateway port for TLS listener", async () => {
    process.env.TAILSCALE_AUTH_KEY = "tskey-auth-test";
    const logs = await runStartup(tmpDir, occupiedPort, undefined, 8443);
    const serveConfig = await readFile(join(tmpDir, ".ts-serve"), "utf8");
    expect(serveConfig).toContain("--https=8443");
    expect(serveConfig).toContain(`127.0.0.1:${occupiedPort}`);
    expect(logs.info.some((m) => m.includes("HTTPS serve configured"))).toBe(true);
    delete process.env.TAILSCALE_AUTH_KEY;
  });

  it("defaults servePort to 443 when not configured", async () => {
    process.env.TAILSCALE_AUTH_KEY = "tskey-auth-test";
    const logs = await runStartup(tmpDir, occupiedPort);
    const serveConfig = await readFile(join(tmpDir, ".ts-serve"), "utf8");
    expect(serveConfig).toContain("--https=443");
    expect(serveConfig).toContain(`127.0.0.1:${occupiedPort}`);
    expect(logs.info.some((m) => m.includes("tailscale-serve:"))).toBe(true);
    delete process.env.TAILSCALE_AUTH_KEY;
  });
});
