/**
 * Real-binary integration tests for TailscaleManager.
 *
 * Downloads actual Tailscale binaries, starts tailscaled as a sidecar,
 * authenticates with an ephemeral key, and exercises the full lifecycle.
 *
 * Designed to run inside a Docker container with NET_ADMIN + /dev/net/tun:
 *   npm run test:real:docker
 *
 * Skipped automatically when TAILSCALE_AUTH_KEY is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, mkdtemp, rm } from "fs/promises";
import { constants } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "net";
import { TailscaleManager } from "./manager.js";

const AUTH_KEY = process.env.TAILSCALE_AUTH_KEY;
const LOGIN_SERVER = process.env.TS_LOGIN_SERVER;

describe.skipIf(!AUTH_KEY)("TailscaleManager (real binaries)", () => {
  let tmpDir: string;
  let mgr: TailscaleManager;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ts-real-integration-"));
    mgr = new TailscaleManager(tmpDir, LOGIN_SERVER);
  }, 10_000);

  afterAll(async () => {
    if (mgr) await mgr.stopDaemon().catch(() => {});
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }, 30_000);

  // ── Binary download ──────────────────────────────────────────────────────

  it("downloads real tailscale binaries", async () => {
    await mgr.ensureBinaries();

    await expect(access(mgr.bin, constants.X_OK)).resolves.toBeUndefined();
    await expect(access(mgr.daemonBin, constants.X_OK)).resolves.toBeUndefined();
  }, 120_000);

  it("ensureBinaries is idempotent (does not re-download)", async () => {
    const before = Date.now();
    await mgr.ensureBinaries(); // bins already exist → noop
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);

  // ── Daemon lifecycle ────────────────────────────────────────────────────

  it("starts daemon and socket becomes responsive", async () => {
    await mgr.startDaemon();
    expect(await mgr.isSocketResponding()).toBe(true);
  }, 60_000);

  it("startDaemon is idempotent", async () => {
    await mgr.startDaemon();
    expect(await mgr.isSocketResponding()).toBe(true);
  }, 15_000);

  // ── Authentication ──────────────────────────────────────────────────────

  it("authenticates with ephemeral auth key", async () => {
    const lines = await mgr.ensure(AUTH_KEY!);
    expect(
      lines.some((l) => l.includes("up!") || l.includes("reusable")),
    ).toBe(true);
  }, 30_000);

  it("ensure is idempotent after auth (reuses state)", async () => {
    const lines = await mgr.ensure();
    expect(lines.some((l) => l.includes("reusable"))).toBe(true);
  }, 15_000);

  // ── Status ──────────────────────────────────────────────────────────────

  it("returns status with Tailscale IP after auth", async () => {
    const lines = await mgr.status();

    expect(lines.some((l) => l === "socket_responding: yes")).toBe(true);
    expect(lines.some((l) => l.startsWith("install_dir:"))).toBe(true);
    expect(lines.some((l) => l === "pid_running: yes")).toBe(true);
    // Tailscale CGNAT range 100.64.0.0/10
    expect(lines.some((l) => l.includes("100."))).toBe(true);
  }, 15_000);

  // ── Serve ───────────────────────────────────────────────────────────────

  it("configures tls-terminated-tcp serve rule", async () => {
    await mgr.serve(["--tls-terminated-tcp", "443", "127.0.0.1:9999"]);
    const status = await mgr.serveStatus();
    expect(status.join("\n")).toContain("127.0.0.1:9999");
  }, 30_000);

  it("serves on a different port than the occupied gateway port", async () => {
    await mgr.serveReset();

    // Occupy a port to simulate a running gateway
    const server: Server = await new Promise((resolve) => {
      const s = createServer();
      s.listen(0, () => resolve(s));
    });
    const gatewayPort = (server.address() as any).port;

    try {
      await mgr.serve(["--tls-terminated-tcp", "8443", `127.0.0.1:${gatewayPort}`]);
      const status = await mgr.serveStatus();
      const statusStr = status.join("\n");
      expect(statusStr).toContain(`127.0.0.1:${gatewayPort}`);
      expect(statusStr).toContain("8443");
    } finally {
      await mgr.serveReset();
      server.close();
    }
  }, 30_000);

  it("resets serve config", async () => {
    await mgr.serveReset();
    const status = await mgr.serveStatus();
    expect(status.join("\n")).not.toContain("127.0.0.1:9999");
  }, 30_000);

  // ── Logs ────────────────────────────────────────────────────────────────

  it("collects recent daemon logs", async () => {
    const logs = await mgr.recentLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain("no log file");
  }, 5_000);

  // ── Shutdown ────────────────────────────────────────────────────────────

  it("stops daemon and socket stops responding", async () => {
    await mgr.stopDaemon();
    expect(await mgr.isSocketResponding()).toBe(false);
  }, 30_000);
});
