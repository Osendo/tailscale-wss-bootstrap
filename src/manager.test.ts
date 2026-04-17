/**
 * Unit tests for TailscaleManager.
 * child_process is mocked at module level — no real subprocesses are spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile, spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TailscaleManager } from "./manager.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// Helper: make the mocked execFile call its callback with stdout/err.
// When error is provided, stdout/stderr are still attached to the error object
// (matching real child_process behavior on non-zero exit).
function mockExec(stdout = "", stderr = "", error: Error | null = null) {
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1];
    if (error) {
      const e: any = error;
      e.stdout = stdout;
      e.stderr = stderr;
      cb(e, stdout, stderr);
    } else {
      cb(null, { stdout, stderr }, "");
    }
    return undefined as any;
  });
}

// Minimal ChildProcess mock for spawn
function mockSpawnProcess(pid = 99999) {
  const child = {
    pid,
    unref: vi.fn(),
    once: vi.fn(),
    stdin: { pipe: vi.fn() },
  };
  vi.mocked(spawn).mockReturnValue(child as any);
  return child;
}

describe("TailscaleManager", () => {
  let tmpDir: string;
  let mgr: TailscaleManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tailscale-test-"));
    mgr = new TailscaleManager(tmpDir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true });
  });

  // ── path properties ──────────────────────────────────────────────────────

  describe("path properties", () => {
    it("derives all paths from stateDir", () => {
      expect(mgr.bin).toBe(join(tmpDir, "tailscale"));
      expect(mgr.daemonBin).toBe(join(tmpDir, "tailscaled"));
      expect(mgr.socket).toBe(join(tmpDir, "tailscaled.sock"));
      expect(mgr.logFile).toBe(join(tmpDir, "tailscaled.log"));
      expect(mgr.pidFile).toBe(join(tmpDir, "tailscaled.pid"));
      expect(mgr.stateFile).toBe(join(tmpDir, "tailscale-manager.state"));
    });
  });

  // ── isPidAlive ────────────────────────────────────────────────────────────

  describe("isPidAlive", () => {
    it("returns true for the current process", () => {
      expect((mgr as any).isPidAlive(process.pid)).toBe(true);
    });

    it("returns false for a non-existent PID", () => {
      expect((mgr as any).isPidAlive(999_999_999)).toBe(false);
    });
  });

  // ── readPid ───────────────────────────────────────────────────────────────

  describe("readPid", () => {
    it("returns null when pid file is absent", async () => {
      expect(await (mgr as any).readPid()).toBeNull();
    });

    it("reads a valid integer PID", async () => {
      await writeFile(mgr.pidFile, "12345\n");
      expect(await (mgr as any).readPid()).toBe(12345);
    });

    it("returns null for non-numeric content", async () => {
      await writeFile(mgr.pidFile, "not-a-number");
      expect(await (mgr as any).readPid()).toBeNull();
    });
  });

  // ── recentLogs ────────────────────────────────────────────────────────────

  describe("recentLogs", () => {
    it("reports missing log file gracefully", async () => {
      const result = await mgr.recentLogs();
      expect(result).toContain("no log file");
    });

    it("returns the last N lines", async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
      await writeFile(mgr.logFile, lines.join("\n"));

      const result = await mgr.recentLogs(10);
      expect(result).toContain("line 99");
      expect(result).not.toContain("line 0\n");
    });

    it("returns all lines when file is shorter than N", async () => {
      await writeFile(mgr.logFile, "only line\n");
      expect(await mgr.recentLogs(10)).toContain("only line");
    });
  });

  // ── ensureBinaries ────────────────────────────────────────────────────────

  describe("ensureBinaries", () => {
    it("skips download when binaries already exist", async () => {
      vi.spyOn(mgr as any, "binsExist").mockResolvedValue(true);
      const download = vi.spyOn(mgr as any, "downloadBinaries").mockResolvedValue(undefined);

      await mgr.ensureBinaries();
      expect(download).not.toHaveBeenCalled();
    });

    it("downloads when binaries are missing", async () => {
      vi.spyOn(mgr as any, "binsExist").mockResolvedValue(false);
      const download = vi.spyOn(mgr as any, "downloadBinaries").mockResolvedValue(undefined);

      await mgr.ensureBinaries();
      expect(download).toHaveBeenCalledOnce();
    });

    it("force-downloads even when binaries exist", async () => {
      vi.spyOn(mgr as any, "binsExist").mockResolvedValue(true);
      const download = vi.spyOn(mgr as any, "downloadBinaries").mockResolvedValue(undefined);

      await mgr.ensureBinaries(true);
      expect(download).toHaveBeenCalledOnce();
    });
  });

  // ── isSocketResponding ────────────────────────────────────────────────────

  describe("isSocketResponding", () => {
    it("returns true when execFile succeeds", async () => {
      mockExec("# Health check", "");
      expect(await mgr.isSocketResponding()).toBe(true);
    });

    it("returns false when execFile throws with no output (socket dead)", async () => {
      mockExec("", "", new Error("socket not found"));
      expect(await mgr.isSocketResponding()).toBe(false);
    });

    it("returns true when execFile throws but has stdout (NeedsLogin)", async () => {
      mockExec("Logged out.", "", new Error("exit code 1"));
      expect(await mgr.isSocketResponding()).toBe(true);
    });

    it("returns false when only stderr (connection refused)", async () => {
      mockExec("", "failed to connect to tailscaled", new Error("exit code 1"));
      expect(await mgr.isSocketResponding()).toBe(false);
    });
  });

  // ── needsLogin ────────────────────────────────────────────────────────────

  describe("needsLogin", () => {
    it("returns false when already authenticated", async () => {
      mockExec("100.64.0.1 myhost ...");
      expect(await (mgr as any).needsLogin()).toBe(false);
    });

    it("returns true when status starts with 'Logged out.'", async () => {
      mockExec("Logged out.");
      expect(await (mgr as any).needsLogin()).toBe(true);
    });

    it("returns true when status starts with 'NeedsLogin'", async () => {
      mockExec("NeedsLogin");
      expect(await (mgr as any).needsLogin()).toBe(true);
    });

    it("returns true when execFile throws (socket down)", async () => {
      mockExec("", "", new Error("no socket"));
      expect(await (mgr as any).needsLogin()).toBe(true);
    });
  });

  // ── findDaemonPid ─────────────────────────────────────────────────────────

  describe("findDaemonPid", () => {
    it("parses the first pid from pgrep output", async () => {
      mockExec("12345 /path/to/tailscaled --statedir=...");
      expect(await (mgr as any).findDaemonPid()).toBe(12345);
    });

    it("returns null when pgrep finds nothing", async () => {
      mockExec("", "", new Error("no match"));
      expect(await (mgr as any).findDaemonPid()).toBeNull();
    });

    it("returns null for non-numeric pgrep output", async () => {
      mockExec("no-pid-here");
      expect(await (mgr as any).findDaemonPid()).toBeNull();
    });
  });

  // ── reconcilePid ──────────────────────────────────────────────────────────

  describe("reconcilePid", () => {
    it("returns pid from file when the process is alive", async () => {
      await writeFile(mgr.pidFile, String(process.pid));
      const pid = await (mgr as any).reconcilePid();
      expect(pid).toBe(process.pid);
    });

    it("falls back to pgrep when pid file has dead pid", async () => {
      await writeFile(mgr.pidFile, "999999999"); // dead pid
      mockExec(String(process.pid) + " tailscaled ...");
      const pid = await (mgr as any).reconcilePid();
      expect(pid).toBe(process.pid);
    });

    it("returns null and removes pid file when no process found", async () => {
      await writeFile(mgr.pidFile, "999999999");
      mockExec("", "", new Error("no match"));
      const pid = await (mgr as any).reconcilePid();
      expect(pid).toBeNull();
    });
  });

  // ── ensure ────────────────────────────────────────────────────────────────

  describe("ensure", () => {
    beforeEach(() => {
      vi.spyOn(mgr, "startDaemon").mockResolvedValue();
    });

    it("returns status when already authenticated", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(false);
      vi.spyOn(mgr, "status").mockResolvedValue(["socket_responding: yes"]);

      const result = await mgr.ensure();
      expect(result).toContain("Tailscale state is reusable, no auth key needed.");
      expect(result).toContain("socket_responding: yes");
    });

    it("throws when login is needed but no auth key given", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(true);
      await expect(mgr.ensure()).rejects.toThrow("TAILSCALE_AUTH_KEY");
    });

    it("calls up() with the provided auth key", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(true);
      const upSpy = vi.spyOn(mgr, "up").mockResolvedValue(["Tailscale is up!"]);

      const result = await mgr.ensure("ts-authkey-test");
      expect(upSpy).toHaveBeenCalledWith("ts-authkey-test", undefined);
      expect(result).toEqual(["Tailscale is up!"]);
    });

    it("propagates custom tags to up()", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(true);
      const upSpy = vi.spyOn(mgr, "up").mockResolvedValue([]);

      await mgr.ensure("key", "tag:custom,tag:server");
      expect(upSpy).toHaveBeenCalledWith("key", "tag:custom,tag:server");
    });
  });

  // ── status ────────────────────────────────────────────────────────────────

  describe("status", () => {
    beforeEach(() => {
      vi.spyOn(mgr, "ensureBinaries").mockResolvedValue();
    });

    it("includes install_dir and pid lines", async () => {
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(null);
      vi.spyOn(mgr, "isSocketResponding").mockResolvedValue(false);

      const lines = await mgr.status();
      expect(lines.some((l) => l.startsWith("install_dir:"))).toBe(true);
      expect(lines.some((l) => l.startsWith("pid:"))).toBe(true);
      expect(lines.some((l) => l === "socket_responding: no")).toBe(true);
    });

    it("appends tailscale status output when socket responds", async () => {
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(process.pid);
      vi.spyOn(mgr, "isSocketResponding").mockResolvedValue(true);
      mockExec("100.64.0.1 myhost tagged-devices");

      const lines = await mgr.status();
      expect(lines).toContain("--- tailscale status ---");
      expect(lines).toContain("100.64.0.1 myhost tagged-devices");
    });
  });

  // ── up ────────────────────────────────────────────────────────────────────

  describe("up", () => {
    it("calls tailscale up with auth key, returns output", async () => {
      vi.spyOn(mgr, "startDaemon").mockResolvedValue();
      mockExec("");

      const result = await mgr.up("ts-key-123");
      expect(result).toContain("Tailscale is up!");

      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("up");
      expect(args.some((a) => a.includes("ts-key-123"))).toBe(true);
      expect(args.every((a) => !a.startsWith("--advertise-tags"))).toBe(true);
    });

    it("passes --advertise-tags when tags are provided", async () => {
      vi.spyOn(mgr, "startDaemon").mockResolvedValue();
      mockExec("");

      await mgr.up("ts-key-123", "tag:server");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args.some((a) => a.includes("tag:server"))).toBe(true);
    });

    it("omits --advertise-tags when tags is empty string", async () => {
      vi.spyOn(mgr, "startDaemon").mockResolvedValue();
      mockExec("");

      await mgr.up("ts-key-123", "");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args.every((a) => !a.startsWith("--advertise-tags"))).toBe(true);
    });

    it("passes --login-server when loginServer is set", async () => {
      const custom = new TailscaleManager(tmpDir, "http://headscale:8080");
      vi.spyOn(custom, "startDaemon").mockResolvedValue();
      mockExec("");

      await custom.up("ts-key-123");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("--login-server=http://headscale:8080");
    });

    it("omits --login-server when loginServer is not set", async () => {
      vi.spyOn(mgr, "startDaemon").mockResolvedValue();
      mockExec("");

      await mgr.up("ts-key-123");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args.every((a) => !a.startsWith("--login-server"))).toBe(true);
    });
  });

  // ── ping ──────────────────────────────────────────────────────────────────

  describe("ping", () => {
    it("forwards target and returns stdout", async () => {
      mockExec("pong from 100.64.0.2");
      const result = await mgr.ping("some-host");
      expect(result).toContain("pong from 100.64.0.2");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("some-host");
    });
  });

  // ── serve ─────────────────────────────────────────────────────────────────

  describe("serve", () => {
    it("checks login and passes args to tailscale serve", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(false);
      mockExec("HTTPS proxy set");

      const result = await mgr.serve(["--https=443", "http://localhost:3001"]);
      expect(result).toContain("HTTPS proxy set");
      const [, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
      expect(args).toContain("serve");
      expect(args).toContain("--https=443");
    });

    it("throws when not logged in", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(true);
      await expect(mgr.serve(["--https=443"])).rejects.toThrow("not logged in");
    });
  });

  describe("serveStatus", () => {
    it("returns serve status output", async () => {
      mockExec("HTTPS 443 / http://127.0.0.1:3001");
      expect(await mgr.serveStatus()).toContain("HTTPS 443 / http://127.0.0.1:3001");
    });
  });

  describe("serveReset", () => {
    it("returns reset output when logged in", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(false);
      mockExec("Serve config reset");
      expect(await mgr.serveReset()).toContain("Serve config reset");
    });

    it("throws when not logged in", async () => {
      vi.spyOn(mgr as any, "needsLogin").mockResolvedValue(true);
      await expect(mgr.serveReset()).rejects.toThrow("not logged in");
    });
  });

  // ── startDaemon ───────────────────────────────────────────────────────────

  describe("startDaemon", () => {
    beforeEach(() => {
      vi.spyOn(mgr, "ensureBinaries").mockResolvedValue(undefined);
      vi.spyOn(mgr as any, "ensureDir").mockResolvedValue(undefined);
    });

    it("recycles zombie daemon (pid alive but socket not responding)", async () => {
      vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.spyOn(mgr, "isSocketResponding")
        .mockResolvedValueOnce(false) // pre-spawn check
        .mockResolvedValueOnce(true); // post-spawn first poll
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(77777);
      vi.spyOn(mgr as any, "isPidAlive")
        .mockReturnValueOnce(true)  // old pid still alive → SIGTERM
        .mockReturnValueOnce(false) // loop check → exited → break
        .mockReturnValue(false);    // final isPidAlive check
      mockSpawnProcess(55557);

      await mgr.startDaemon();

      expect(killSpy).toHaveBeenCalledWith(77777, "SIGTERM");
      killSpy.mockRestore();
    });

    it("returns early when socket is already responding", async () => {
      vi.spyOn(mgr, "isSocketResponding").mockResolvedValue(true);
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(null);

      await mgr.startDaemon();
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    });

    it("spawns daemon and returns when socket becomes ready", async () => {
      vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });
      vi.spyOn(mgr, "isSocketResponding")
        .mockResolvedValueOnce(false) // pre-spawn check
        .mockResolvedValueOnce(true); // first poll after spawn
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(null);
      mockSpawnProcess(55555);

      await mgr.startDaemon();

      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        mgr.daemonBin,
        expect.arrayContaining([`--statedir=${tmpDir}`, `--socket=${mgr.socket}`]),
        expect.objectContaining({ detached: true })
      );
    });

    it("throws after 30 polls when socket never responds", async () => {
      vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });
      vi.spyOn(mgr, "isSocketResponding").mockResolvedValue(false);
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(null);
      mockSpawnProcess(55556);

      await expect(mgr.startDaemon()).rejects.toThrow("socket timeout");
    });
  });

  // ── stopDaemon ────────────────────────────────────────────────────────────

  describe("stopDaemon", () => {
    it("does nothing when no process found", async () => {
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(null);
      await mgr.stopDaemon(); // should not throw
    });

    it("sends SIGTERM then exits when process dies", async () => {
      vi.spyOn(global, "setTimeout").mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      vi.spyOn(mgr as any, "reconcilePid").mockResolvedValue(process.pid);
      vi.spyOn(mgr as any, "isPidAlive")
        .mockReturnValueOnce(true)  // initial check → enter if block → SIGTERM
        .mockReturnValue(false);    // loop check → process exited → break

      await mgr.stopDaemon();

      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
      killSpy.mockRestore();
    });
  });
});
