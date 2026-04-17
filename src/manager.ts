import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { constants, openSync } from "fs";
import { access, appendFile, chmod, mkdir, readFile, rm, writeFile } from "fs/promises";
import { arch } from "os";
import { join } from "path";
import { Readable } from "stream";

const execFileAsync = promisify(execFile);

export type ServeProto = "https" | "http" | "tcp" | "tls-terminated-tcp";

export function protoFlag(proto: ServeProto, port: number): string {
  return `--${proto}=${port}`;
}

const ARCH_MAP: Record<string, string> = {
  x64: "amd64",
  arm64: "arm64",
  arm: "arm",
  ia32: "386",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TailscaleManager {
  readonly bin: string;
  readonly daemonBin: string;
  readonly socket: string;
  readonly logFile: string;
  readonly pidFile: string;
  readonly stateFile: string;

  constructor(readonly stateDir: string, readonly loginServer?: string) {
    this.bin = join(stateDir, "tailscale");
    this.daemonBin = join(stateDir, "tailscaled");
    this.socket = join(stateDir, "tailscaled.sock");
    this.logFile = join(stateDir, "tailscaled.log");
    this.pidFile = join(stateDir, "tailscaled.pid");
    this.stateFile = join(stateDir, "tailscale-manager.state");
  }

  private tsArch(): string {
    const a = arch();
    const mapped = ARCH_MAP[a];
    if (!mapped) throw new Error(`Unsupported architecture: ${a}`);
    return mapped;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
  }

  private async binsExist(): Promise<boolean> {
    try {
      await access(this.bin, constants.X_OK);
      await access(this.daemonBin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async downloadBinaries(): Promise<void> {
    const tsArch = this.tsArch();

    const indexRes = await fetch("https://pkgs.tailscale.com/stable/");
    const indexHtml = await indexRes.text();
    const match = indexHtml.match(new RegExp(`tailscale_([\\d.]+)_${tsArch}\\.tgz`));
    if (!match) throw new Error("Failed to detect latest Tailscale version");

    const version = match[1];
    const url = `https://pkgs.tailscale.com/stable/tailscale_${version}_${tsArch}.tgz`;

    await this.ensureDir();

    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", ["-xz", "-C", this.stateDir, "--strip-components=1"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      const readable = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      readable.pipe(tar.stdin!);
      tar.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))
      );
      tar.once("error", reject);
      readable.once("error", reject);
    });

    await chmod(this.bin, 0o755);
    await chmod(this.daemonBin, 0o755);
  }

  async ensureBinaries(forceUpdate = false): Promise<void> {
    if (!forceUpdate && (await this.binsExist())) return;
    await this.downloadBinaries();
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async readPid(): Promise<number | null> {
    try {
      const n = parseInt((await readFile(this.pidFile, "utf8")).trim(), 10);
      return isNaN(n) ? null : n;
    } catch {
      return null;
    }
  }

  private async findDaemonPid(): Promise<number | null> {
    try {
      const { stdout } = await execFileAsync("pgrep", [
        "-af",
        `${this.daemonBin} --statedir=${this.stateDir}`,
      ]);
      const n = parseInt((stdout ?? "").trim().split(/\s+/)[0], 10);
      return isNaN(n) ? null : n;
    } catch {
      return null;
    }
  }

  private async reconcilePid(): Promise<number | null> {
    const pid = await this.readPid();
    if (pid !== null && this.isPidAlive(pid)) return pid;

    const found = await this.findDaemonPid();
    if (found !== null && this.isPidAlive(found)) {
      await writeFile(this.pidFile, String(found));
      return found;
    }

    await rm(this.pidFile).catch(() => {});
    return null;
  }

  async isSocketResponding(): Promise<boolean> {
    try {
      await execFileAsync(this.bin, [`--socket=${this.socket}`, "status"], { timeout: 5000 });
      return true;
    } catch (err: unknown) {
      // `tailscale status` exits non-zero in NeedsLogin/Stopped state,
      // but the socket is still alive. Presence of stdout means the CLI
      // connected to the daemon. Stderr-only (e.g. "failed to connect")
      // means the socket is truly unreachable.
      const e = err as { stdout?: string };
      if (e.stdout) return true;
      return false;
    }
  }

  private async needsLogin(): Promise<boolean> {
    try {
      const { stdout, stderr } = await execFileAsync(
        this.bin,
        [`--socket=${this.socket}`, "status"],
        { timeout: 5000 }
      );
      return /^(Logged out\.|NeedsLogin)/m.test(stdout + stderr);
    } catch (err: unknown) {
      // Non-zero exit with stdout means the CLI did talk to the daemon.
      const e = err as { stdout?: string; stderr?: string };
      const combined = (e.stdout ?? "") + (e.stderr ?? "");
      if (combined) return /^(Logged out\.|NeedsLogin)/m.test(combined);
      // No output at all → socket is probably dead, treat as needs login.
      return true;
    }
  }

  async startDaemon(): Promise<void> {
    await this.ensureBinaries();
    await this.ensureDir();

    if (await this.isSocketResponding()) {
      await this.reconcilePid();
      return;
    }

    const oldPid = await this.reconcilePid();
    if (oldPid !== null && this.isPidAlive(oldPid)) {
      process.kill(oldPid, "SIGTERM");
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        if (!this.isPidAlive(oldPid)) break;
      }
      if (this.isPidAlive(oldPid)) process.kill(oldPid, "SIGKILL");
      await rm(this.socket).catch(() => {});
      await rm(this.pidFile).catch(() => {});
    }

    const hasTun = await access("/dev/net/tun").then(() => true).catch(() => false);
    const daemonArgs = [
      `--statedir=${this.stateDir}`,
      `--socket=${this.socket}`,
      ...(hasTun ? [] : ["--tun=userspace-networking"]),
    ];

    const logFd = openSync(this.logFile, "a");
    const child = spawn(this.daemonBin, daemonArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    const pid = child.pid!;

    await writeFile(this.pidFile, String(pid));
    await appendFile(this.stateFile, `started ${new Date().toISOString()} pid=${pid}\n`);

    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await this.isSocketResponding()) return;
    }

    throw new Error(
      `tailscaled failed to start (socket timeout)\n${await this.recentLogs(40)}`
    );
  }

  async stopDaemon(): Promise<void> {
    const pid = await this.reconcilePid();
    if (pid !== null && this.isPidAlive(pid)) {
      process.kill(pid, "SIGTERM");
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if (!this.isPidAlive(pid)) break;
      }
      if (this.isPidAlive(pid)) process.kill(pid, "SIGKILL");
    }
    await rm(this.pidFile).catch(() => {});
    await rm(this.socket).catch(() => {});
    await appendFile(this.stateFile, `stopped ${new Date().toISOString()}\n`);
  }

  async ensure(authKey?: string, tags?: string): Promise<string[]> {
    await this.startDaemon();

    if (!(await this.needsLogin())) {
      return ["Tailscale state is reusable, no auth key needed.", ...(await this.status())];
    }

    if (!authKey) {
      throw new Error(
        "TAILSCALE_AUTH_KEY is not set and existing state requires login or re-auth"
      );
    }

    return this.up(authKey, tags);
  }

  async up(authKey: string, tags?: string): Promise<string[]> {
    await this.startDaemon();
    const { stdout } = await execFileAsync(this.bin, [
      `--socket=${this.socket}`,
      "up",
      `--auth-key=${authKey}`,
      ...(tags ? [`--advertise-tags=${tags}`] : []),
      ...(this.loginServer ? [`--login-server=${this.loginServer}`] : []),
    ]);
    return [(stdout ?? "").trim(), "Tailscale is up!"].filter(Boolean);
  }

  async status(): Promise<string[]> {
    await this.ensureBinaries();
    const pid = await this.reconcilePid();
    const socketOk = await this.isSocketResponding();

    const lines: string[] = [
      `install_dir: ${this.stateDir}`,
      `pid: ${pid ?? "<none>"}`,
      `pid_running: ${pid !== null && this.isPidAlive(pid) ? "yes" : "no"}`,
      `socket_responding: ${socketOk ? "yes" : "no"}`,
    ];

    if (socketOk) {
      let tsStatus: string;
      try {
        const res = await execFileAsync(this.bin, [
          `--socket=${this.socket}`,
          "status",
        ]);
        tsStatus = res.stdout;
      } catch (e: unknown) {
        // Non-zero exit still carries useful stdout (e.g. NeedsLogin state).
        tsStatus = (e as { stdout?: string }).stdout ?? (e as Error).message;
      }
      lines.push("--- tailscale status ---", (tsStatus ?? "").trim());
    }

    return lines;
  }

  async recentLogs(n = 80): Promise<string> {
    try {
      const content = await readFile(this.logFile, "utf8");
      return content.split("\n").slice(-n).join("\n");
    } catch {
      return `(no log file at ${this.logFile})`;
    }
  }

  async ping(target: string): Promise<string[]> {
    const { stdout } = await execFileAsync(this.bin, [
      `--socket=${this.socket}`,
      "ping",
      "-c",
      "3",
      target,
    ]);
    return [(stdout ?? "").trim()];
  }

  async serve(args: string[]): Promise<string[]> {
    if (await this.needsLogin()) {
      throw new Error("Cannot configure serve: Tailscale is not logged in");
    }
    // --bg ensures `tailscale serve` exits immediately instead of
    // running as a foreground process (default since Tailscale 1.56+).
    const fullArgs = args.includes("--bg") ? args : ["--bg", ...args];
    const { stdout } = await execFileAsync(this.bin, [
      `--socket=${this.socket}`,
      "serve",
      ...fullArgs,
    ]);
    return [(stdout ?? "").trim()];
  }

  async serveStatus(): Promise<string[]> {
    const { stdout } = await execFileAsync(this.bin, [
      `--socket=${this.socket}`,
      "serve",
      "status",
    ]);
    return [(stdout ?? "").trim()];
  }

  async serveReset(): Promise<string[]> {
    if (await this.needsLogin()) {
      throw new Error("Cannot reset serve: Tailscale is not logged in");
    }
    const { stdout } = await execFileAsync(this.bin, [
      `--socket=${this.socket}`,
      "serve",
      "reset",
    ]);
    return [(stdout ?? "").trim()];
  }

}
