import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { CONFIG_DIR } from "openclaw/plugin-sdk/setup-tools";
import { join } from "path";
import { TailscaleManager, type ServeProto, protoFlag } from "./src/manager.js";

export default definePluginEntry({
  id: "tailscale-wss-bootstrap",
  register(api) {
    const stateDir =
      (api.pluginConfig.stateDir as string | undefined) ?? join(CONFIG_DIR, ".tailscale");
    const loginServer = api.pluginConfig.loginServer as string | undefined;
    const servePort = Number(api.pluginConfig.servePort) || 443;
    const mgr = new TailscaleManager(stateDir, loginServer);

    api.registerService({
      name: "tailscale",
      description: "Tailscale VPN sidecar — ensures daemon is running and authenticated",
      async start() {
        await mgr.ensure(process.env.TAILSCALE_AUTH_KEY);
      },
      async stop() {
        await mgr.stopDaemon();
      },
    });

    api.registerTool({
      name: "tailscale_serve",
      description:
        "Manage Tailscale Serve — expose local ports over your tailnet. " +
        "Actions: set (configure a serve rule), status (show current config), reset (remove all rules).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "status", "reset"],
            description: "set — create/replace a serve rule; status — show current serve config; reset — remove all serve rules",
          },
          proto: {
            type: "string",
            enum: ["https", "http", "tcp", "tls-terminated-tcp"],
            description: "Serve protocol (default: https). Only used with action=set.",
          },
          port: {
            type: "number",
            description: "External port Tailscale listens on (default: from plugin config or 443). Only used with action=set.",
          },
          target: {
            type: "string",
            description: "Local target, e.g. http://127.0.0.1:3001 or tcp://127.0.0.1:22. Required for action=set.",
          },
        },
        required: ["action"],
      },
      async execute(_id: string, params: Record<string, unknown>): Promise<ToolResult> {
        const action = params.action as string;

        if (action === "status") {
          const lines = await mgr.serveStatus();
          return { content: [{ type: "text", text: lines.join("\n") || "No serve config" }] };
        }

        if (action === "reset") {
          const lines = await mgr.serveReset();
          return { content: [{ type: "text", text: lines.join("\n") || "Serve config reset" }] };
        }

        // action === "set"
        const proto = ((params.proto as string) || "https") as ServeProto;
        const port = Number(params.port) || servePort;
        const target = params.target as string | undefined;
        if (!target) {
          return { content: [{ type: "text", text: "Error: 'target' is required for action=set (e.g. http://127.0.0.1:3001)" }] };
        }

        const flag = protoFlag(proto, port);
        const lines = await mgr.serve([flag, target]);
        return {
          content: [{
            type: "text",
            text: `Configured (${flag} ${target})\n\n${lines.join("\n")}`,
          }],
        };
      },
    });

    api.on("gateway_start", async (event) => {
      try {
        const lines = await mgr.ensure(process.env.TAILSCALE_AUTH_KEY);
        const msg = lines.join("\n") || "OK";
        if (event && Array.isArray(event.messages)) {
          event.messages.push(`tailscale: ${msg}`);
        }
      } catch (err: unknown) {
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 800);
        if (event && Array.isArray(event.messages)) {
          event.messages.push(`tailscale failed: ${detail}`);
        }
        return;
      }

      const gatewayPort = api.config.gateway?.port;
      if (!gatewayPort) return;

      try {
        const target = `http://127.0.0.1:${gatewayPort}`;
        const flag = protoFlag("https", servePort);
        const lines = await mgr.serve([flag, target]);
        const msg = `HTTPS serve configured (:${servePort} → 127.0.0.1:${gatewayPort})`;
        if (event && Array.isArray(event.messages)) {
          event.messages.push(`tailscale-serve: ${msg}`);
        }
      } catch (err: unknown) {
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 800);
        if (event && Array.isArray(event.messages)) {
          event.messages.push(`tailscale-serve failed: ${detail}`);
        }
      }
    });
  },
});
