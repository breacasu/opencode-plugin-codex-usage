# opencode-plugin-codex-usage

OpenCode TUI plugin that displays Codex-reported usage limits in the right sidebar.

It reads rate-limit data from `codex app-server` using Codex's `account/rateLimits/read` RPC and displays the returned usage windows. These numbers are reported by Codex; they are not a complete view of ChatGPT Plus billing, plan entitlements, or account usage.

<p>
  <img src="docs/dark.png" alt="Example output (dark)" width="420" />
  <img src="docs/light.png" alt="Example output (light)" width="420" />
</p>

## What it shows

- The main Codex usage window.
- Additional model-specific windows when Codex exposes them, for example `GPT-5.3-Codex-Spark`.
- The remaining percentage and reset time reported for each available window.
- The available reset-credit count when Codex reports it. This count is separate from the per-window usage credit balance; Codex does not expose an expiry for reset credits.
- The usage credit balance reported on an individual rate-limit window, when available. It is not the reset-credit count.

## Requirements

- OpenCode v2 with its TUI. Both legacy v2.0.20 colors and the grouped theme tokens used by v2.1.2 are supported.
- The `codex` CLI installed and available on your `PATH`, unless you set `codexBinary` to a custom path.
- A working Codex login so `codex app-server` can read its rate limits.

## Installation and configuration

Install the published package by adding it to OpenCode's **global** `cli.json` in the global OpenCode configuration directory. To use this fork after its changes are published, replace the package value below with `github:breacasu/opencode-plugin-codex-usage#main`. The schema URL and plugin entry format for OpenCode v2 are:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "opencode-plugin-codex-usage",
      "options": {
        "refreshMs": 30000
      }
    }
  ]
}
```

For a local checkout, install its dependencies with `bun install` (or `npm install --ignore-scripts --package-lock=false`), then use its absolute directory path as the package value:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-plugin-codex-usage",
      "options": {
        "refreshMs": 30000
      }
    }
  ]
}
```

Use the absolute path to the plugin directory, not a path to an individual source file. Restart OpenCode after changing the global configuration. This setup documents the global `cli.json`; it does not claim that a project-level `cli.json` is loaded.

The plugin adds a `Codex Usage` section to the right sidebar. It starts expanded in Codex or OpenAI-backed sessions and remains available but collapsed in other sessions.

## Options

Pass options in the entry's `options` object in `cli.json`:

- `refreshMs`: Poll interval in milliseconds. Default: `30000`; minimum enforced value: `15000`; maximum: `2147483647`.
- `codexBinary`: Command or absolute path used to launch Codex. Default: `codex`.
- `codexHome`: Directory used as `CODEX_HOME` when launching Codex. Default: unset.

If `codex` is not on your `PATH`, set `codexBinary` to the full path of the executable. A non-empty `codexHome` overrides any `CODEX_HOME` inherited from the OpenCode process. If omitted or empty, the inherited environment is left unchanged, allowing Codex to use an existing `CODEX_HOME` or its normal `~/.codex` fallback.

The plugin treats provider IDs containing `openai` or `codex` as a heuristic for expanding the section; this substring match does not prove that the session is authenticated to Codex. When a session has no qualifying assistant/model-switch history yet, the section starts collapsed.

## Troubleshooting

- **`codex CLI not found`**: Install the Codex CLI, or set `codexBinary` to its absolute path.
- **`No Codex usage data available`**: Make sure Codex is logged in and can return rate-limit data from `codex app-server`.
- **`Codex usage request failed`**: Check that Codex is logged in under the same `codexHome` (or inherited `CODEX_HOME`) used by the plugin; run `codex login` there if needed. The app-server diagnostic is intentionally hidden because it may contain authentication or account data.
- **The plugin appears but stays collapsed**: This is expected in non-Codex sessions. Open a Codex or OpenAI-backed session to see it expand automatically.
- **Listed under `/plugins` but missing from the sidebar after an OpenCode update**: Older plugin code could crash by treating grouped theme tokens as individual colors. This renderer supports both formats; restart OpenCode after updating the plugin.
- **The sidebar does not update immediately**: The default refresh interval is `30000ms`. The plugin also refreshes when the session becomes idle.
- **A request times out or cleanup is incomplete**: The panel should show an error instead of remaining on its initial Loading state. A new Codex process is blocked until the prior child emits `close`; if it never does, restart OpenCode after investigating the local Codex process. This prevents repeated overlapping spawns but does not forcibly clean up a process tree.

## Local verification

From a local checkout, run the import smoke check and tests:

```bash
bun run check
bun test
bun run typecheck
```

The check verifies that the plugin module can be imported with OpenTUI runtime support.
The sidebar regression test covers legacy colors and grouped RGBA tokens, including collapsed, empty, error and usage-data states.

## Performance notes

- CPU and memory usage are low; only a small in-memory snapshot is retained.
- The plugin does not call the model or inject prompt/context into OpenCode sessions.
- Each refresh launches a short-lived `codex app-server` process to read current usage windows. Increase `refreshMs` to `60000` or `120000` to reduce refresh frequency.
- A terminal result (success, timeout, cancellation or failure) updates the request promptly, even if the Codex child has not closed. SIGTERM and, if needed, SIGKILL after 250 ms are independent of that update. The module-level ownership guard continues blocking new children until `close`, including across mounted Views; if `close` never arrives, the UI reports a failure instead of remaining on initial Loading, but automatic refresh cannot spawn again in that module instance. Only the direct child is terminated; process-tree cleanup is not managed. Stderr and sensitive stream errors are never displayed, and stdout buffering is bounded.
