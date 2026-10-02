/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import {
  durationLabel,
  errorMessage,
  fetchRateLimits,
  getRefreshMs,
  percentLeft,
  resetLabel,
  rowLabel,
  snapshotName,
  validatePluginOptions,
  type PluginOptions,
  type RateLimitSnapshot,
  type RateLimitState,
  type RateLimitWindow,
} from "./codex-usage"

function remainingColor(remaining: number, theme: Plugin.Context["theme"]) {
  if (remaining < 15) return theme.error
  if (remaining < 50) return theme.warning
  return theme.success
}

function sessionUsesCodex(context: Plugin.Context, sessionID: string) {
  const messages = context.data.session.message.list(sessionID)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== "assistant" && message.type !== "model-switched") continue
    const providerID = message.model.providerID.toLowerCase()
    if (providerID.includes("openai") || providerID.includes("codex")) return true
    return false
  }
  return false
}

function SnapshotView(props: {
  snapshot: RateLimitSnapshot
  theme: () => Plugin.Context["theme"]
}) {
  const rows = () =>
    [
      props.snapshot.primary
        ? {
            key: "primary",
            label: rowLabel(props.snapshot.primary, "5h"),
            window: props.snapshot.primary,
          }
        : undefined,
      props.snapshot.secondary
        ? {
            key: "secondary",
            label: rowLabel(props.snapshot.secondary, "Weekly"),
            window: props.snapshot.secondary,
          }
        : undefined,
    ].filter((item): item is { key: string; label: string; window: RateLimitWindow } => !!item)

  const isPrimaryBucket = () => (props.snapshot.limitId || "codex").toLowerCase() === "codex"
  const heading = () => (isPrimaryBucket() ? "Overall limit left" : `${snapshotName(props.snapshot)} limit left`)
  const credits = () => {
    const value = props.snapshot.credits
    if (value?.unlimited) return "Unlimited"
    return value?.balance?.trim() || undefined
  }

  return (
    <box flexDirection="column" gap={0} marginTop={isPrimaryBucket() ? 0 : 1}>
      <text fg={props.theme().textMuted}>{heading()}:</text>
      <For each={rows()}>
        {(row) => {
          const remaining = percentLeft(row.window)
          const color = remainingColor(remaining, props.theme())
          return (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={0}>
                <text fg={props.theme().textMuted}>{row.label}</text>
                <text fg={color}> {remaining}%</text>
                <text fg={props.theme().textMuted}> (resets {resetLabel(row.window.resetsAt)})</text>
              </box>
            </box>
          )
        }}
      </For>
      <Show when={credits()}>
        {(balance) => (
          <box flexDirection="row" gap={0}>
            <text fg={props.theme().textMuted}>Credits available: </text>
            <text fg={props.theme().text}>{balance()}</text>
          </box>
        )}
      </Show>
    </box>
  )
}

function View(props: { context: Plugin.Context; options: PluginOptions; sessionID: string }) {
  const [state, setState] = createSignal<RateLimitState>({ status: "loading" })
  const [collapsed, setCollapsed] = createSignal(!sessionUsesCodex(props.context, props.sessionID))
  const theme = () => props.context.theme
  const codexBinary = props.options?.codexBinary || "codex"
  const codexHome = props.options?.codexHome || undefined
  const refreshMs = getRefreshMs(props.options)
  const toggleCollapsed = () => setCollapsed((value) => !value)

  let disposed = false
  let running = false
  let queued = false
  let activeRequest: AbortController | undefined

  const refresh = async () => {
    if (running) {
      queued = true
      return
    }

    running = true
    const controller = new AbortController()
    activeRequest = controller
    try {
      const data = await fetchRateLimits(codexBinary, codexHome, controller.signal)
      if (!disposed) setState({ status: "ready", data })
    } catch (error) {
      if (!disposed) {
        const previous = state().data
        setState({
          status: "error",
          message: errorMessage(error),
          ...(previous ? { data: previous } : {}),
        })
      }
    } finally {
      if (activeRequest === controller) activeRequest = undefined
      running = false
      if (queued && !disposed) {
        queued = false
        void refresh()
      }
    }
  }

  createEffect(() => {
    props.sessionID
    setCollapsed(!sessionUsesCodex(props.context, props.sessionID))
    void refresh()
  })

  const stopIdle = props.context.data.on("session.idle", (event) => {
    if (event.data.sessionID === props.sessionID) void refresh()
  })
  const interval = setInterval(() => {
    void refresh()
  }, refreshMs)

  onCleanup(() => {
    disposed = true
    queued = false
    activeRequest?.abort()
    clearInterval(interval)
    stopIdle()
  })

  const snapshots = () => state().data?.snapshots || []
  const errorText = () => {
    const current = state()
    return current.status === "error" ? current.message : " "
  }

  return (
    <box flexDirection="column" gap={0}>
      <box
        focusable
        onMouseDown={toggleCollapsed}
        onKeyDown={(event) => {
          if (event.name === "return" || event.name === "space") {
            event.preventDefault()
            toggleCollapsed()
          }
        }}
      >
        <text fg={theme().text}>
          <b>{collapsed() ? "▶" : "▼"} Codex Usage</b>
        </text>
      </box>
      <Show when={!collapsed()}>
        <Switch>
          <Match when={state().status === "error" && !state().data}>
            <text fg={theme().warning}>{errorText()}</text>
          </Match>
          <Match when={state().status === "loading" && !state().data}>
            <text fg={theme().textMuted}>Loading Codex usage...</text>
          </Match>
          <Match when={snapshots().length === 0}>
            <text fg={theme().textMuted}>No Codex usage data available.</text>
          </Match>
          <Match when={snapshots().length > 0}>
            <For each={snapshots()}>{(snapshot) => <SnapshotView snapshot={snapshot} theme={theme} />}</For>
          </Match>
        </Switch>
        <Show when={state().status === "error" && state().data}>
          <text fg={theme().warning}>refresh failed: {errorText()}</text>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-plugin-codex-usage",
  setup(context) {
    const options = validatePluginOptions(context.options)
    return context.ui.slot({
      before: "sidebar.content",
      render: (props) => <View context={context} options={options} sessionID={props.sessionID} />,
    })
  },
})
