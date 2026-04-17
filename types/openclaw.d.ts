declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(opts: {
    id: string;
    register(api: OpenClawPluginApi): void;
  }): unknown;
}

declare module "openclaw/plugin-sdk/setup-tools" {
  export const CONFIG_DIR: string;
}

interface OpenClawConfig {
  gateway?: {
    port?: number;
  };
  [key: string]: unknown;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface OpenClawPluginApi {
  id: string;
  config: OpenClawConfig;
  pluginConfig: Record<string, unknown>;
  on(event: string, handler: (event: any, ctx?: any) => Promise<void> | void, opts?: { priority?: number }): void;
  registerHook(
    events: string | string[],
    handler: (event: InternalHookEvent) => Promise<void> | void,
    opts?: { name?: string; description?: string },
  ): void;
  registerTool(
    tool: {
      name: string;
      description: string;
      parameters: unknown;
      execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
    },
    opts?: { optional?: boolean }
  ): void;
}

interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway" | "message";
  action: string;
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];
}

interface OpenClawHookEvent {
  type: string;
  timestamp: string;
  messages: string[];
  context?: Record<string, unknown>;
}
