import { describe, it, expect, vi, beforeEach } from "vitest";
import plugin from "./plugin.js";
import { TailscaleManager } from "./manager.js";

const mockEnsure = vi.fn().mockResolvedValue(undefined);
const mockStatus = vi.fn().mockResolvedValue(["mock-status"]);

vi.mock("./manager.js", () => {
  return {
    TailscaleManager: vi.fn().mockImplementation(() => {
      return {
        ensure: mockEnsure,
        status: mockStatus,
      };
    }),
  };
});

describe("Tailscale Plugin", () => {
  let mockApi: any;
  let hooks: Record<string, Function> = {};
  let commands: Record<string, any> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    hooks = {};
    commands = {};
    mockApi = {
      config: {},
      pluginConfig: {},
      on: vi.fn(),
      registerHook: vi.fn((name: string, fn: Function) => {
        hooks[name] = fn;
      }),
      registerTool: vi.fn((cmd: any) => {
        commands[cmd.name] = cmd;
      }),
    };
  });

  it("registers gateway:startup hook and tailscale-status command", async () => {
    mockApi.config = { workspaceDir: "/tmp" };
    await plugin.register(mockApi);

    expect(mockApi.registerHook).toHaveBeenCalledWith("gateway:startup", expect.any(Function));
    expect(mockApi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "tailscale-status" }));
  });

  it("starts tailscale during gateway:startup", async () => {
    mockApi.config = { workspaceDir: "/tmp/workspace" };
    mockApi.pluginConfig = {
      authKey: "ts-key-123",
      tags: "tag:test",
    };

    await plugin.register(mockApi);
    const event = { messages: [] as string[] };
    
    await hooks["gateway:startup"](event);

    expect(TailscaleManager).toHaveBeenCalledWith(expect.stringContaining(".tailscale"));
    expect(mockEnsure).toHaveBeenCalledWith("ts-key-123", "tag:test");
    expect(event.messages).toContain("Tailscale: Started successfully.");
    expect(event.messages).toContain("Tailscale: mock-status");
  });

  it("skips startup if authKey is missing", async () => {
    mockApi.config = { workspaceDir: "/tmp" };
    mockApi.pluginConfig = {};
    process.env.TAILSCALE_AUTH_KEY = "";
    
    await plugin.register(mockApi);
    const event = { messages: [] as string[] };
    
    await hooks["gateway:startup"](event);

    expect(event.messages).toContain("Tailscale: No auth key provided. Skipping startup.");
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
