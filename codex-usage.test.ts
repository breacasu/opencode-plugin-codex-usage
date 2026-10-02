import { describe, expect, mock, test } from "bun:test"
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { Plugin } from "@opencode/plugin/tui"
import {
  durationLabel,
  errorMessage,
  fetchRateLimits,
  getRefreshMs,
  normalizeSnapshots,
  percentLeft,
  snapshotName,
  validatePluginOptions,
} from "./codex-usage"

describe("Codex usage formatting and response normalization", () => {
  test("preserves refresh interval minimum and default", () => {
    expect(getRefreshMs(undefined)).toBe(30000)
    expect(getRefreshMs({ refreshMs: 1 })).toBe(15000)
    expect(getRefreshMs({ refreshMs: 30500.9 })).toBe(30500)
    expect(getRefreshMs({ refreshMs: Number.NaN })).toBe(30000)
    expect(getRefreshMs({ refreshMs: Number.MAX_VALUE })).toBe(2147483647)
  })

  test("formats rate limits and clamps remaining percentage", () => {
    expect(durationLabel({ windowDurationMins: 10080 }, "5h")).toBe("Weekly")
    expect(durationLabel({ windowDurationMins: 90 }, "5h")).toBe("90m")
    expect(percentLeft({ usedPercent: 65.6 })).toBe(34)
    expect(percentLeft({ usedPercent: 130 })).toBe(0)
    expect(percentLeft({ usedPercent: -10 })).toBe(100)
  })

  test("normalizes and orders buckets, preferring the primary Codex limit", () => {
    const snapshots = normalizeSnapshots({
      rateLimitsByLimitId: {
        zeta: { limitId: "zeta", limitName: "gpt-5-codex" },
        codex: { limitId: "codex" },
        alpha: { limitId: "alpha", limitName: "alpha" },
      },
    })
    expect(snapshots.map((snapshot) => snapshot.limitId)).toEqual(["codex", "alpha", "zeta"])
    expect(snapshotName(snapshots[2]!)).toBe("GPT-5-Codex")
    expect(normalizeSnapshots({ rateLimits: { limitId: "codex" } })).toHaveLength(1)
    expect(normalizeSnapshots({ rateLimits: null, rateLimitsByLimitId: { codex: { limitId: "codex" } } })).toHaveLength(1)
    expect(normalizeSnapshots({ rateLimits: null })).toEqual([])
  })

  test("maps delegated-auth failures to the existing actionable message", () => {
    expect(errorMessage(new Error("401 unauthorized"))).toContain("codex login")
    expect(errorMessage(new Error("spawn codex ENOENT"))).toBe("codex CLI not found")
  })

  test("rejects invalid runtime options rather than falling back to another account", () => {
    expect(() => validatePluginOptions({ codexBinary: 12 })).toThrow("codexBinary must be a string")
    expect(() => validatePluginOptions({ codexBinary: "  " })).toThrow("codexBinary must not be empty")
    expect(() => validatePluginOptions({ codexHome: false })).toThrow("codexHome must be a string")
    expect(validatePluginOptions({ codexBinary: "codex-test" })).toEqual({ codexBinary: "codex-test" })
    expect(validatePluginOptions({ codexHome: "" })).toEqual({ codexHome: "" })
  })
})

describe("Codex app-server protocol", () => {
  test("performs initialize and rate-limit read without Codex credentials", async () => {
    const script = [
      "const rl=require('node:readline').createInterface({input:process.stdin});",
      "rl.on('line', line => { const m=JSON.parse(line);",
      "if(m.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
      "if(m.method==='account/rateLimits/read') process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'codex',primary:{usedPercent:25}}}})+'\\n');",
      "});",
    ].join("")
    const data = await fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )
    expect(data.snapshots[0]?.primary?.usedPercent).toBe(25)
  })

  test("rejects initialize errors without leaking server diagnostics", async () => {
    const script = "process.stdin.on('data', () => process.stdout.write(JSON.stringify({id:1,error:{message:'sensitive auth payload'}})+'\\n'))"
    await expect(fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )).rejects.toThrow("initialization failed")
  })

  test("rejects malformed result envelopes", async () => {
    const script = [
      "const rl=require('node:readline').createInterface({input:process.stdin});",
      "rl.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
      "if(m.id===2) process.stdout.write(JSON.stringify({id:2})+'\\n'); });",
    ].join("")
    await expect(fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )).rejects.toThrow("malformed JSON-RPC result")
  })

  test("rejects null and malformed rate-limit structures without throwing from stdout", async () => {
    for (const result of [
      "null",
      '{"rateLimits":null,"rateLimitsByLimitId":[]}',
      '{"rateLimitsByLimitId":{"codex":null}}',
      '{"rateLimits":{"limitId":3}}',
      '{"rateLimits":{"primary":[]}}',
      '{"rateLimits":{"primary":{"usedPercent":"25"}}}',
      '{"rateLimits":{"credits":42,"planType":[]}}',
      '{"rateLimits":{"credits":{"hasCredits":"yes"}}}',
      '{"rateLimits":{"credits":{"unlimited":0}}}',
      '{"rateLimits":{"credits":{"balance":42}}}',
    ]) {
      const script = `const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); if(m.id===2) process.stdout.write(JSON.stringify({id:2,result:JSON.parse(${JSON.stringify(result)})})+'\\n'); });`
      await expect(fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
        nodeSpawn(process.execPath, ["-e", script], options),
      )).rejects.toThrow(/malformed|invalid/)
    }
  })

  test("ignores duplicate initialize replies and unsolicited usage replies", async () => {
    const script = [
      "const rl=require('node:readline').createInterface({input:process.stdin}); let reads=0;",
      "rl.on('line', line => { const m=JSON.parse(line); if(m.method==='initialize') { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'wrong'}}})+'\\n'); process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); }",
      "if(m.method==='account/rateLimits/read') { reads++; process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'codex'}}})+'\\n'); setTimeout(() => { if(reads!==1) process.exit(9); process.exit(0); }, 20); } });",
    ].join("")
    const data = await fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )
    expect(data.snapshots[0]?.limitId).toBe("codex")
  })

  test("rejects usage RPC errors without exposing server payloads", async () => {
    const script = [
      "const rl=require('node:readline').createInterface({input:process.stdin});",
      "rl.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
      "if(m.id===2) process.stdout.write(JSON.stringify({id:2,error:{message:'private account payload'}})+'\\n'); });",
    ].join("")
    await expect(fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )).rejects.toThrow("usage request failed")
  })

  test("rejects clean exit without a response", async () => {
    await expect(fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('data', () => process.exit(0))"], options),
    )).rejects.toThrow("exited without a usage result")
  })

  test("processes a response buffered until close", async () => {
    const script = [
      "const rl=require('node:readline').createInterface({input:process.stdin});",
      "rl.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
      "if(m.id===2) process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'codex'}}}), () => process.exit(0)); });",
    ].join("")
    const data = await fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )
    expect(data.snapshots[0]?.limitId).toBe("codex")
  })

  test("retains request ownership until a successful child closes", async () => {
    if (process.platform === "win32") return
    let requestSettled = false
    const script = [
      "process.on('SIGTERM',()=>{}); const rl=require('node:readline').createInterface({input:process.stdin});",
      "rl.on('line', line => { const m=JSON.parse(line); if(m.id===1) process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n');",
      "if(m.id===2) { process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'codex'}}})+'\\n'); setTimeout(() => process.exit(0), 500); } });",
    ].join("")
    const request = fetchRateLimits(process.execPath, undefined, undefined, (_command, _args, options) =>
      nodeSpawn(process.execPath, ["-e", script], options),
    )
    void request.finally(() => { requestSettled = true }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requestSettled).toBe(false)
    expect((await request).snapshots[0]?.limitId).toBe("codex")
    expect(requestSettled).toBe(true)
  })

  test("retains cancelled request ownership until a SIGTERM-ignoring child is killed and closed", async () => {
    if (process.platform === "win32") return
    const controller = new AbortController()
    let childExit: Promise<[number | null, NodeJS.Signals | null]> | undefined
    let markReady!: () => void
    const childReady = new Promise<void>((resolve) => { markReady = resolve })
    let requestSettled = false
    const request = fetchRateLimits(process.execPath, undefined, controller.signal, (_command, _args, options) => {
      const child = nodeSpawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stderr.write('ready\\n'); setInterval(() => {}, 1000)"], options)
      child.stderr?.once("data", markReady)
      childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve([code, signal])))
      return child
    })
    await childReady
    controller.abort()
    void request.finally(() => { requestSettled = true }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(requestSettled).toBe(false)
    await expect(request).rejects.toThrow("cancelled")
    expect(await childExit).toEqual([null, "SIGKILL"])
  })

  test("prevents overlapping subprocesses until the prior child closes", async () => {
    const makeChild = () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: mock(() => true),
      })
      return child as unknown as ChildProcess
    }
    const firstChild = makeChild()
    const secondChild = makeChild()
    const thirdChild = makeChild()
    const children = [firstChild, secondChild, thirdChild]
    let spawnCalls = 0
    const spawnMock = () => children[spawnCalls++]!
    const first = fetchRateLimits("codex", undefined, undefined, spawnMock)
    await expect(fetchRateLimits("codex", undefined, undefined, spawnMock)).rejects.toThrow("still closing")
    expect(spawnCalls).toBe(1)
    firstChild.emit("close", 0)
    await expect(first).rejects.toThrow("exited without a usage result")

    const afterClose = fetchRateLimits("codex", undefined, undefined, spawnMock)
    expect(spawnCalls).toBe(2)
    secondChild.emit("close", 0)
    await expect(afterClose).rejects.toThrow("exited without a usage result")
    expect(spawnCalls).toBe(2)
  })
})

describe("V2 plugin slot runtime", () => {
  test("renders the sidebar and disposes refresh resources", async () => {
    const solidJsClientPath: string = "solid-js/dist/solid.js"
    mock.module("solid-js", () => import(solidJsClientPath))
    await import("@opentui/solid/runtime-plugin-support")
    const { testRender } = await import("@opentui/solid")
    let fetchCalls = 0
    let activeSignal: AbortSignal | undefined
    let nextData: { fetchedAt: number; snapshots: { limitId: string; primary: { usedPercent: number }; credits?: { balance?: string | null; unlimited?: boolean } }[] } | undefined = {
      fetchedAt: 0,
      snapshots: [{ limitId: "codex", primary: { usedPercent: 19 }, credits: { balance: "$12.50" } }],
    }
    mock.module("./codex-usage", () => ({
      durationLabel: (_window: unknown, fallback: string) => fallback,
      errorMessage: (error: unknown) => String(error),
      getRefreshMs: () => 15000,
      fetchRateLimits: (_binary: string, _home: string | undefined, signal: AbortSignal) => {
        fetchCalls += 1
        activeSignal = signal
        if (nextData) {
          const result = nextData
          nextData = undefined
          return Promise.resolve(result)
        }
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))
      },
      percentLeft: (window: { usedPercent?: number } | undefined) => Math.max(0, 100 - (window?.usedPercent ?? 0)),
      resetLabel: () => "reset unavailable",
      rowLabel: (_window: unknown, fallback: string) => `${fallback}:`,
      snapshotName: () => "Codex",
    }))
    const { default: plugin } = await import("./tui")
    const intervalToken = {} as ReturnType<typeof setInterval>
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const clearedIntervals: ReturnType<typeof setInterval>[] = []
    globalThis.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15000) return intervalToken
      return originalSetInterval(callback, timeout, ...args)
    }) as typeof setInterval
    globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
      clearedIntervals.push(handle as ReturnType<typeof setInterval>)
      if (handle !== intervalToken) originalClearInterval(handle)
    }) as typeof clearInterval
    let claim: Parameters<Plugin.Context["ui"]["slot"]>[0] | undefined
    let render: ((input: { sessionID: string }) => unknown) | undefined
    let idleListener: ((event: { data: { sessionID: string } }) => void) | undefined
    let unsubscribed = false
    const context = {
      options: {},
      theme: { text: "white", textMuted: "gray", error: "red", warning: "yellow", success: "green" },
      data: {
        session: { message: { list: () => [{ type: "assistant", model: { providerID: "openai" } }] } },
        on: (_event: string, listener: typeof idleListener) => {
          idleListener = listener
          return () => { unsubscribed = true }
        },
      },
      ui: { slot: (value: Parameters<Plugin.Context["ui"]["slot"]>[0]) => { claim = value; render = value.render as (input: { sessionID: string }) => unknown; return () => {} } },
    } as unknown as Plugin.Context
    plugin.setup(context)
    expect(claim).toEqual({ before: "sidebar.content", render: expect.any(Function) })
    expect(render).toBeDefined()
    let setup: Awaited<ReturnType<typeof testRender>> | undefined
    try {
      setup = await testRender(() => render!({ sessionID: "session-test" }) as never, { width: 80, height: 24 })
      await setup.renderOnce()
      const balanceFrame = await setup.waitForFrame((value) => value.includes("Credits available: $12.50"))
      expect(balanceFrame).toContain("Codex Usage")
      expect(balanceFrame).toContain("Credits available: $12.50")
      expect(fetchCalls).toBe(1)
      expect(activeSignal?.aborted).toBe(false)

      nextData = { fetchedAt: 0, snapshots: [{ limitId: "codex", primary: { usedPercent: 38 }, credits: { unlimited: true, balance: "$12.50" } }] }
      idleListener?.({ data: { sessionID: "session-test" } })
      const unlimitedFrame = await setup.waitForFrame((value) => value.includes("62%") && value.includes("Credits available: Unlimited"))
      expect(unlimitedFrame).not.toContain("$12.50")

      nextData = { fetchedAt: 0, snapshots: [{ limitId: "codex", primary: { usedPercent: 27 }, credits: { balance: "  " } }] }
      idleListener?.({ data: { sessionID: "session-test" } })
      const noBalanceFrame = await setup.waitForFrame((value) => value.includes("73%"))
      expect(noBalanceFrame).not.toContain("Credits available:")

      nextData = { fetchedAt: 0, snapshots: [{ limitId: "codex", primary: { usedPercent: 44 } }] }
      idleListener?.({ data: { sessionID: "session-test" } })
      const noCreditsFrame = await setup.waitForFrame((value) => value.includes("56%"))
      expect(noCreditsFrame).not.toContain("Credits available:")

      idleListener?.({ data: { sessionID: "session-test" } })
      expect(fetchCalls).toBe(5)
      expect(activeSignal?.aborted).toBe(false)
    } finally {
      setup?.renderer.destroy()
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
    expect(unsubscribed).toBe(true)
    expect(activeSignal?.aborted).toBe(true)
    expect(clearedIntervals).toContain(intervalToken)
    expect(fetchCalls).toBe(5)
  })
})
