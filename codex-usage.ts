import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"

export type PluginOptions = {
  codexBinary?: string
  codexHome?: string
  refreshMs?: number
}

export type RateLimitWindow = {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

export type RateLimitCredits = {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: string | null
}

export type RateLimitSnapshot = {
  limitId?: string | null
  limitName?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: RateLimitCredits | null
  planType?: string | null
}

export type RateLimitResetCredits = {
  availableCount: number
}

export type RateLimitResponse = {
  rateLimits?: RateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null
  rateLimitResetCredits?: RateLimitResetCredits | null
}

export type RateLimitData = {
  fetchedAt: number
  snapshots: RateLimitSnapshot[]
  rateLimitResetCredits?: RateLimitResetCredits
}

export type RateLimitState =
  | { status: "loading"; data?: RateLimitData }
  | { status: "ready"; data: RateLimitData }
  | { status: "error"; message: string; data?: RateLimitData }

const MIN_REFRESH_MS = 15000
const DEFAULT_REFRESH_MS = 30000
const MAX_REFRESH_MS = 2_147_483_647
let subprocessOwned = false

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/token_invalidated|invalidated|unauthorized|\b401\b/i.test(message)) {
    return "Codex login expired. Run `codex login` and restart OpenCode."
  }
  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) return "codex CLI not found"
    return error.message
  }
  return message
}

export function getRefreshMs(options: PluginOptions | undefined) {
  if (typeof options?.refreshMs !== "number" || !Number.isFinite(options.refreshMs)) return DEFAULT_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(options.refreshMs)))
}

export function validatePluginOptions(options: unknown): PluginOptions {
  if (options === undefined) return {}
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Codex usage options must be an object")
  const value = options as Record<string, unknown>
  if (value.codexBinary !== undefined && typeof value.codexBinary !== "string") throw new Error("codexBinary must be a string")
  if (typeof value.codexBinary === "string" && !value.codexBinary.trim()) throw new Error("codexBinary must not be empty")
  if (value.codexHome !== undefined && typeof value.codexHome !== "string") throw new Error("codexHome must be a string")
  return value as PluginOptions
}

export function durationLabel(window: RateLimitWindow | null | undefined, fallback: string) {
  const minutes = window?.windowDurationMins
  if (!minutes) return fallback
  if (minutes === 10080) return "Weekly"
  if (minutes === 43200) return "Monthly"
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export function percentLeft(window: RateLimitWindow | null | undefined) {
  const used = window?.usedPercent ?? 0
  return Math.max(0, Math.min(100, Math.round(100 - used)))
}

export function resetLabel(timestamp: number | null | undefined) {
  if (!timestamp) return "reset unavailable"
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return "reset unavailable"
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  const day = new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(date)
  const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(date)
  return `${time} ${day} ${month}`
}

export function rowLabel(window: RateLimitWindow | null | undefined, fallback: string) {
  return `${durationLabel(window, fallback)}:`
}

function titleCase(part: string) {
  if (!part) return part
  if (/^gpt$/i.test(part)) return "GPT"
  if (/^codex$/i.test(part)) return "Codex"
  if (/^[0-9.]+$/.test(part)) return part
  return part.charAt(0).toUpperCase() + part.slice(1)
}

export function snapshotName(snapshot: RateLimitSnapshot) {
  const raw = snapshot.limitName?.trim() || snapshot.limitId?.trim() || "codex"
  return raw.replace(/_/g, "-").split("-").map(titleCase).join("-")
}

function snapshotOrder(snapshot: RateLimitSnapshot) {
  if ((snapshot.limitId || "codex").toLowerCase() === "codex") return ""
  return snapshotName(snapshot).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validateWindow(value: unknown, label: string): RateLimitWindow | null | undefined {
  if (value === undefined || value === null) return value
  if (!isRecord(value)) throw new Error(`Codex returned malformed ${label} window`)
  if (value.usedPercent !== undefined && (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent))) {
    throw new Error(`Codex returned malformed ${label} consumed value`)
  }
  if (value.windowDurationMins !== undefined && value.windowDurationMins !== null && (typeof value.windowDurationMins !== "number" || !Number.isFinite(value.windowDurationMins))) {
    throw new Error(`Codex returned malformed ${label} duration`)
  }
  if (value.resetsAt !== undefined && value.resetsAt !== null && (typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt))) {
    throw new Error(`Codex returned malformed ${label} reset time`)
  }
  return value as RateLimitWindow
}

function validateCredits(value: unknown, label: string): RateLimitCredits | null | undefined {
  if (value === undefined || value === null) return value
  if (!isRecord(value)) throw new Error(`Codex returned malformed ${label} credits`)
  if (value.hasCredits !== undefined && typeof value.hasCredits !== "boolean") throw new Error(`Codex returned malformed ${label} credits hasCredits`)
  if (value.unlimited !== undefined && typeof value.unlimited !== "boolean") throw new Error(`Codex returned malformed ${label} credits unlimited`)
  if (value.balance !== undefined && value.balance !== null && typeof value.balance !== "string") throw new Error(`Codex returned malformed ${label} credits balance`)
  return value as RateLimitCredits
}

function validateSnapshot(value: unknown, label: string): RateLimitSnapshot {
  if (!isRecord(value)) throw new Error(`Codex returned malformed ${label} snapshot`)
  for (const key of ["limitId", "limitName"] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== "string") throw new Error(`Codex returned malformed ${label} ${key}`)
  }
  if (value.planType !== undefined && value.planType !== null && typeof value.planType !== "string") throw new Error(`Codex returned malformed ${label} planType`)
  const primary = validateWindow(value.primary, `${label} primary`)
  const secondary = validateWindow(value.secondary, `${label} secondary`)
  const credits = validateCredits(value.credits, label)
  return { ...value, primary, secondary, credits } as RateLimitSnapshot
}

export function normalizeSnapshots(input: unknown) {
  if (!isRecord(input)) throw new Error("Codex returned a malformed rate-limit result")
  let primary: RateLimitSnapshot | null | undefined
  if (input.rateLimits !== undefined && input.rateLimits !== null) primary = validateSnapshot(input.rateLimits, "rateLimits")
  let byId: Record<string, unknown> = {}
  if (input.rateLimitsByLimitId !== undefined && input.rateLimitsByLimitId !== null) {
    if (!isRecord(input.rateLimitsByLimitId)) throw new Error("Codex returned malformed rateLimitsByLimitId map")
    byId = input.rateLimitsByLimitId
  }
  const snapshots = Object.entries(byId).map(([key, value]) => validateSnapshot(value, `rateLimitsByLimitId.${key}`))
  if (snapshots.length > 0) return snapshots.sort((a, b) => snapshotOrder(a).localeCompare(snapshotOrder(b)))
  return primary ? [primary] : []
}

function validateResetCredits(value: unknown): RateLimitResetCredits | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new Error("Codex returned malformed rateLimitResetCredits")
  const count = value.availableCount
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Codex returned malformed rateLimitResetCredits availableCount")
  }
  return { availableCount: count }
}

function normalizeRateLimitResponse(input: unknown) {
  if (!isRecord(input)) throw new Error("Codex returned a malformed rate-limit result")
  const snapshots = normalizeSnapshots(input)
  const rateLimitResetCredits = validateResetCredits(input.rateLimitResetCredits)
  return { snapshots, ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}) }
}

type SpawnProcess = (command: string, args: string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess

/** Fetches usage through Codex's delegated app-server auth; credentials are never read by this plugin. */
export async function fetchRateLimits(
  codexBinary: string,
  codexHome?: string,
  signal?: AbortSignal,
  spawnProcess: SpawnProcess = nodeSpawn,
) {
  return new Promise<RateLimitData>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex usage request cancelled"))
      return
    }
    if (subprocessOwned) {
      reject(new Error("another Codex usage subprocess is still closing"))
      return
    }
    subprocessOwned = true
    let child: ChildProcess
    try {
      child = spawnProcess(codexBinary, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}),
      })
    } catch (error) {
      subprocessOwned = false
      reject(error)
      return
    }
    let stdout = ""
    let finalizing = false
    let settled = false
    let closed = false
    let outcome: { error?: Error; result?: RateLimitData } | undefined
    let initialized = false
    let requestSent = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timeout = setTimeout(() => finish(new Error("timed out while reading Codex usage")), 15000)

    const finish = (error?: Error, result?: RateLimitData) => {
      if (finalizing || settled) return
      finalizing = true
      outcome = { ...(error ? { error } : {}), ...(result ? { result } : {}) }
      clearTimeout(timeout)
      if (!closed && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM") } catch { /* close/error owns completion */ }
        killTimer = setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL") } catch { /* never release ownership before close */ }
          }
        }, 250)
        killTimer.unref()
      }
      if (closed) settleAfterClose()
    }
    const settleAfterClose = () => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      clearTimeout(timeout)
      signal?.removeEventListener("abort", onAbort)
      child.removeListener("error", onChildError)
      child.removeListener("close", onClose)
      child.stdin?.removeListener("error", onStreamError)
      child.stdout?.removeListener("data", onStdout)
      child.stderr?.removeListener("data", drainStderr)
      const result = outcome
      if (result?.error) reject(result.error)
      else if (result?.result) resolve(result.result)
      else reject(new Error("Codex returned no usage data"))
    }
    const onAbort = () => finish(new Error("Codex usage request cancelled"))
    signal?.addEventListener("abort", onAbort, { once: true })

    const send = (message: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(message)}\n`)
    const handleLine = (line: string) => {
      if (!line.trim() || finalizing) return
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) {
          finish(new Error("Codex returned a malformed JSON-RPC envelope"))
          return
        }
        const message = parsed as { id?: unknown; result?: unknown; error?: unknown }
        if (message.id !== 1 && message.id !== 2) return
        if (message.id === 1 && (initialized || requestSent)) return
        if (message.id === 2 && (!initialized || !requestSent)) return
        if (message.error) {
          finish(new Error(message.id === 1 ? "Codex app-server initialization failed" : "Codex usage request failed"))
          return
        }
        if (!Object.prototype.hasOwnProperty.call(message, "result") || !isRecord(message.result)) {
          finish(new Error("Codex returned a malformed JSON-RPC result"))
          return
        }
        if (message.id === 1) {
          initialized = true
          send({ method: "initialized", params: {} })
          requestSent = true
          send({ method: "account/rateLimits/read", id: 2 })
          return
        }
        if (!initialized || !requestSent) return
        const normalized = normalizeRateLimitResponse(message.result)
        finish(undefined, { fetchedAt: Date.now(), ...normalized })
      } catch {
        finish(new Error("Codex returned malformed or invalid usage data"))
      }
    }
    const onChildError = (error: Error) => finish(error instanceof Error ? error : new Error(String(error)))
    const onStreamError = (error: Error) => finish(error instanceof Error ? error : new Error(String(error)))
    const drainStderr = () => { /* stderr may contain authentication or account data; drain without logging */ }
    const onStdout = (chunk: Buffer) => {
      if (finalizing) return
      stdout += chunk.toString()
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    }
    const onClose = (code: number | null) => {
      closed = true
      subprocessOwned = false
      if (killTimer) clearTimeout(killTimer)
      if (!finalizing && stdout.trim()) handleLine(stdout)
      if (!finalizing) finish(new Error(code === 0 ? "Codex exited without a usage result" : `codex exited with code ${code}`))
      settleAfterClose()
    }
    child.on("error", onChildError)
    child.stdin?.on("error", onStreamError)
    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", drainStderr)
    child.on("close", onClose)
    send({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "opencode_codex_usage", title: "OpenCode Codex Usage", version: "0.1.0" } },
    })
  })
}
