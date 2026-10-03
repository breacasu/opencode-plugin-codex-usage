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

- OpenCode v2.0.20 with its TUI.
- The `codex` CLI installed and available on your `PATH`, unless you set `codexBinary` to a custom path.
- A working Codex login so `codex app-server` can read its rate limits.

## Installation and configuration

Install the published package by adding it to OpenCode's **global** `cli.json` in the global OpenCode configuration directory. The schema URL and plugin entry format for OpenCode v2.0.20 are:

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

For a local checkout, install its dependencies with `bun install`, then use the absolute directory path as a `file:///...` package value:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/opencode-plugin-codex-usage",
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
- **The sidebar does not update immediately**: The default refresh interval is `30000ms`. The plugin also refreshes when the session becomes idle.

## Local verification

From a local checkout, run the import smoke check and tests:

```bash
bun run check
bun test
```

The check verifies that the plugin module can be imported with OpenTUI runtime support.

## Performance notes

- CPU and memory usage are low; only a small in-memory snapshot is retained.
- The plugin does not call the model or inject prompt/context into OpenCode sessions.
- Each refresh launches a short-lived `codex app-server` process to read current usage windows. Increase `refreshMs` to `60000` or `120000` to reduce refresh frequency.
- Cancellation and timeout terminate the direct Codex executable and wait for its close event before another refresh can start. A module-level guard also prevents overlapping subprocesses across mounted Views. This is fail-closed: there is no timeout fallback that releases ownership before `close`, so refresh may remain stalled indefinitely if termination fails or descendants retain inherited pipes. Only the direct child is terminated; process-tree cleanup is not managed, and Codex is expected to clean up any descendants it creates.
