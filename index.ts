import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { CONFIG_DIR } from "openclaw/plugin-sdk/setup-tools";
import { join } from "path";
import { TailscaleManager } from "./src/manager.js";

export default definePluginEntry({
  id: "tailscale-wss-bootstrap",
  register(api) {
    const stateDir =
      (api.pluginConfig.stateDir as string | undefined) ?? join(CONFIG_DIR, ".tailscale");
    const loginServer = api.pluginConfig.loginServer as string | undefined;
    const servePort = Number(api.pluginConfig.servePort) || 443;

    api.on("gateway_start", async (event) => {
      console.log("[tailscale-wss-bootstrap] хук gateway_start сработал!");
      const mgr = new TailscaleManager(stateDir, loginServer);

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
        await mgr.serve(["--tls-terminated-tcp", String(servePort), `127.0.0.1:${gatewayPort}`]);
        const serveLines = await mgr.serveStatus();
        const status = serveLines.join("\n");
        const verified = status.includes(`127.0.0.1:${gatewayPort}`);

        if (verified) {
          const msg = `WSS ready (tcp:${servePort} → 127.0.0.1:${gatewayPort})`;
          if (event && Array.isArray(event.messages)) {
            event.messages.push(`tailscale-serve: ${msg}`);
          }
        } else if (event && Array.isArray(event.messages)) {
          event.messages.push(`tailscale-serve: status inconclusive: ${status}`);
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
