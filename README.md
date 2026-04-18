# tailscale-wss-bootstrap

OpenClaw plugin that ensures the local Tailscale sidecar is running and WSS-serving on `gateway:startup`.

## Why

Many convenient OpenClaw distributions — like [KiloClaw](https://kilo.ai/docs/kiloclaw) — deliver the platform as a managed SaaS. You get a working gateway out of the box with a [limited set of pre-installed software](https://kilo.ai/docs/kiloclaw/pre-installed-software). You can install additional packages, but everything outside of `/root/.openclaw` gets wiped on every redeploy.

This works fine until you need to reach something on your home network — a Home Assistant instance, a TrueNAS box for disk health reports, or any other local service that isn't exposed to the internet. At that point you need a tunnel, and installing Tailscale on a locked-down host turns into a "20-minute adventure" (it's never 20 minutes).

This plugin solves it by:

- **Storing both the Tailscale binary and its state inside `/root/.openclaw`**, so everything survives redeploys without manual reinstallation.
- **Downloading Tailscale on first run** if the binary is missing — no system package manager required.
- **Reusing existing registration** — once the node is authenticated, subsequent gateway restarts skip the auth key entirely.
- **Automatically configuring Tailscale Serve** for WSS passthrough, so the gateway is reachable over your tailnet with zero extra setup.

## What it does

On every gateway start the plugin:

1. Checks if the Tailscale binary is installed — downloads it if not
2. Starts `tailscaled` as a detached sidecar process (userspace networking if `/dev/net/tun` is absent)
3. Reuses existing registered state if available — no auth key needed
4. Authenticates with `TAILSCALE_AUTH_KEY` only when the node requires login or re-auth
5. If `gateway.port` is set in OpenClaw config, configures Tailscale Serve with `--https=<servePort> http://127.0.0.1:<gatewayPort>`

## Installation

```bash
cp -r <this-repo> /root/.openclaw/plugins/tailscale-wss-bootstrap
openclaw plugins enable tailscale-wss-bootstrap
```

## Configuration

The plugin works out of the box with zero configuration. All settings below are optional.

| Key | Default | Description |
|---|---|---|
| `stateDir` | `{openclaw_dir}/.tailscale` | Directory for Tailscale binaries, state, socket, and logs |
| `loginServer` | _(none — uses Tailscale SaaS)_ | Custom control server URL (e.g. Headscale) |
| `servePort` | `443` | External TLS port for Tailscale Serve (must not conflict with other listeners) |

<details>
<summary>Example: custom config (fully optional)</summary>

```json
{
  "plugins": {
    "entries": {
      "tailscale-wss-bootstrap": {
        "config": {
          "stateDir": "/custom/path/.tailscale",
          "loginServer": "http://headscale.local:8080",
          "servePort": 8443
        }
      }
    }
  }
}
```
</details>

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TAILSCALE_AUTH_KEY` | Only on first login / re-auth | Tailscale auth key (tags are optional, passed separately) |

## Agent tool: `tailscale_serve`

The plugin registers a `tailscale_serve` tool that the agent can invoke to manage Tailscale Serve rules dynamically:

| Parameter | Type | Description |
|---|---|---|
| `action` | `"set" \| "status" \| "reset"` | **Required.** set — create/replace a rule; status — show config; reset — remove all rules |
| `proto` | `"https" \| "http" \| "tcp" \| "tls-terminated-tcp"` | Serve protocol (default: `https`). Only for `action=set`. |
| `port` | `number` | External port (default: from `servePort` config or `443`). Only for `action=set`. |
| `target` | `string` | Local target, e.g. `http://127.0.0.1:3001`. Required for `action=set`. |

## HTTPS serve (automatic)

When `gateway.port` is set in OpenClaw config, the plugin automatically runs:

```
tailscale serve --https=<servePort> http://127.0.0.1:<gatewayPort>
```

The `servePort` (default `443`) is the external TLS port that Tailscale listens on; `gatewayPort` is the local port the gateway is bound to. They are intentionally separate so you can avoid port conflicts (e.g. if something else already listens on 443).

This means the plugin is safe to restart repeatedly and will self-heal if the serve config drifts.

The startup message confirms the outcome:

```
tailscale-serve: HTTPS serve configured (:443 → 127.0.0.1:3001)
tailscale-serve: HTTPS serve already active (:443 → 127.0.0.1:3001)
```

### Why this matters

Tailscale Serve automatically terminates TLS and forwards traffic to the local gateway port. This means the gateway becomes reachable over WSS from anywhere on your tailnet — without exposing it to the public internet, without managing certificates, and without touching DNS.

This unlocks a powerful setup with [OpenClaw Nodes](https://docs.openclaw.ai/nodes). A Node is a companion device that connects to the gateway and exposes a command surface — `system.run`, `camera.*`, `canvas.*`, and more. The gateway forwards agent tool calls to the node, and the node executes them locally.

With this plugin, you can run the gateway on a KiloClaw host (or any machine), give it a stable WSS endpoint on your tailnet, and then connect a Node running on your home server, NAS, or laptop. The agent talks to the gateway; the gateway routes `exec` calls to the node; the node runs commands on your LAN with direct access to Home Assistant, TrueNAS, Prometheus — anything on the local network. No port forwarding, no public exposure.

## TailscaleManager API

The `TailscaleManager` class in [src/manager.ts](src/manager.ts) can be reused in other plugins:

```typescript
import { TailscaleManager } from "./src/manager.js";

const mgr = new TailscaleManager("/path/to/.tailscale");

await mgr.ensure(process.env.TAILSCALE_AUTH_KEY);
await mgr.status();
await mgr.ping("hostname.tail-net.ts.net");
await mgr.serve(["--https=443", "http://127.0.0.1:3001"]);
await mgr.reconcileServe("https", 443, "http://127.0.0.1:3001");
await mgr.serveStatus();
await mgr.serveReset();
await mgr.stopDaemon();
```

## Development

```bash
npm install
npm test                    # unit + integration with fake binaries
npm run test:real:docker    # real Tailscale binaries in Docker (requires TAILSCALE_AUTH_KEY)
npm run test:real:headscale # self-contained: spins up Headscale + runs real tests (no secrets)
npm run typecheck           # tsc --noEmit
```

### Headscale CI

The `test-real` job in CI uses [Headscale](https://github.com/juanfont/headscale) — a self-hosted Tailscale control server — so no external auth key is needed. The flow:

1. Starts a Headscale container with [test/headscale.yaml](test/headscale.yaml)
2. Creates a user + pre-auth key via `headscale` CLI
3. Builds the test Docker image and runs it against the local Headscale

Run locally with `npm run test:real:headscale` (requires Docker).

### Test structure

| File | What | Subprocess mocking |
|---|---|---|
| `manager.test.ts` | Unit tests — all methods, child_process fully mocked | Yes |
| `manager.integration.test.ts` | Domain + plugin hook tests with fake binaries | No (real processes) |
| `manager.real.test.ts` | Full lifecycle with real Tailscale binaries | No (Docker only) |
