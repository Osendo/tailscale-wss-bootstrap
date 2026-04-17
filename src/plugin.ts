import { TailscaleManager } from "./manager.js";
import path from "path";

/**
 * OpenClaw Plugin for Tailscale Integration.
 * 
 * This plugin starts a Tailscale daemon when the gateway starts,
 * allowing OpenClaw to communicate over the Tailscale network.
 */
export default {
  id: "tailscale-integration",
  async register(api: any) {
    const config = api.config;
    const tsConfig = api.pluginConfig || {};
    
    // Tailscale files will be stored in the workspace directory
    const workspaceDir = config.workspaceDir || process.cwd();
    const tailscaleDir = tsConfig.stateDir || path.join(workspaceDir, ".tailscale");
    
    const manager = new TailscaleManager(tailscaleDir);

    api.registerHook("gateway:startup", async (event: any) => {
      const authKey = tsConfig.authKey || process.env.TAILSCALE_AUTH_KEY;
      const tags = tsConfig.tags || process.env.TAILSCALE_TAGS;

      if (!authKey) {
        event.messages.push("Tailscale: No auth key provided. Skipping startup.");
        return;
      }

      event.messages.push("Tailscale: Ensuring binaries and starting daemon...");
      try {
        await manager.ensure(authKey, tags);
        const status = await manager.status();
        event.messages.push("Tailscale: Started successfully.");
        event.messages.push(...status.map(line => `Tailscale: ${line}`));
      } catch (err: any) {
        event.messages.push(`Tailscale: Failed to start: ${err.message}`);
      }
    });

    // Optional: Add a command to get Tailscale status
    api.registerTool({
      name: "tailscale-status",
      description: "Get Tailscale status",
      async execute() {
        try {
          const status = await manager.status();
          return status.join("\n");
        } catch (err: any) {
          return `Tailscale error: ${err.message}`;
        }
      }
    });
  }
};
