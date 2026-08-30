import { beforeEach, describe, expect, it, vi } from "vitest"
import { isStepCount, streamText } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

import { createAnalysisTools } from "./analysis.server"

const mocks = vi.hoisted(() => {
  class SandboxTestError extends Error {
    code: string
    context: Record<string, unknown>
    constructor(response: { code: string; message: string; context?: Record<string, unknown> }) {
      super(response.message)
      this.code = response.code
      this.context = response.context ?? {}
    }
  }
  class ContainerUnavailableError extends SandboxTestError {
  }
  class OperationInterruptedError extends SandboxTestError {
    get reason() { return this.context.reason }
    get retryable() { return this.context.retryable }
  }
  class RPCTransportError extends SandboxTestError {
    get kind() { return this.context.kind }
  }
  class RuntimeControlProtocolError extends SandboxTestError {}
  class ProcessWaitTimeoutError extends SandboxTestError {
    constructor(message: string) {
      super({ code: "PROCESS_WAIT_TIMEOUT", message })
    }
  }
  class ProcessAbortedError extends SandboxTestError {
    constructor(message: string) {
      super({ code: "PROCESS_ABORTED", message })
    }
  }
  return {
    ContainerUnavailableError,
    OperationInterruptedError,
    ProcessAbortedError,
    ProcessWaitTimeoutError,
    RPCTransportError,
    RuntimeControlProtocolError,
    getSandbox: vi.fn(),
  }
})

vi.mock("@cloudflare/sandbox", () => mocks)
vi.mock("cloudflare:workers", () => ({
  env: { ANALYSIS_SANDBOX: {}, PHOLIO_API_BASE_URL: "https://example.test" },
}))
vi.mock("@/auth/api-token.server", () => ({
  createUserApiToken: vi.fn(async () => "token"),
}))

type Output = {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
  signal?: number
}

function processHandle(
  output: Output | (() => Promise<Output>) = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
  }
) {
  return {
    id: crypto.randomUUID(),
    pid: 123,
    output: vi.fn(typeof output === "function" ? output : async () => output),
    kill: vi.fn(async () => undefined),
    waitForExit: vi.fn(async () => ({ code: 0, timedOut: false })),
  }
}

function sandboxFixture(options?: {
  analysis?: ReturnType<typeof processHandle>
  cleanup?: ReturnType<typeof processHandle>
  execError?: Error
  readContent?: string
}) {
  const mkdir = processHandle()
  const analysis = options?.analysis ?? processHandle()
  const cleanup = options?.cleanup ?? processHandle()
  const exec = vi.fn(
    async (argv: ReadonlyArray<string>, _options?: unknown) => {
      if (argv[0] === "mkdir") return mkdir
      if (argv[0] === "rm") return cleanup
      if (options?.execError) throw options.execError
      return analysis
    }
  )
  return {
    sandbox: {
      exec,
      writeFile: vi.fn(async (_path: string, _content: string) => undefined),
      readFile: vi.fn(async (_path: string) => ({
        content:
          options?.readContent ??
          JSON.stringify({
            summary: "Calculated the return.",
            result: { returnPct: 12.5 },
          }),
      })),
    },
    mkdir,
    analysis,
    cleanup,
    exec,
  }
}

function executeTool(
  userId = "user-1",
  conversationId = "thread-1",
  reporter?: Parameters<typeof createAnalysisTools>[2],
  defer?: Parameters<typeof createAnalysisTools>[3]
) {
  const execute = createAnalysisTools(userId, conversationId, reporter, defer)
    .analysis_run_code.execute
  if (!execute) throw new Error("analysis tool must be executable")
  return execute
}

describe("analysis sandbox preview lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers()
    mocks.getSandbox.mockReset()
    vi.restoreAllMocks()
  })

  it("uses one normalized sandbox identity per conversation and a unique run directory", async () => {
    const first = sandboxFixture()
    const second = sandboxFixture()
    mocks.getSandbox
      .mockReturnValueOnce(first.sandbox)
      .mockReturnValueOnce(second.sandbox)
    const userId = "user_2abcDEFghiJKLmnopQRSTuvwXYZ0123456789"
    const conversationId = "550e8400-e29b-41d4-a716-446655440000"
    await executeTool(userId, conversationId)(
      { task: "Calculate", code: "print('one')" },
      { toolCallId: "call-1" } as never
    )
    await executeTool(userId, conversationId)(
      { task: "Calculate", code: "print('two')" },
      { toolCallId: "call-2" } as never
    )

    expect(mocks.getSandbox.mock.calls[0]?.[1]).toBe(
      mocks.getSandbox.mock.calls[1]?.[1]
    )
    const id = mocks.getSandbox.mock.calls[0]?.[1]
    expect(id).toMatch(/^analysis-[0-9a-f]{52}$/u)
    expect(id.length).toBeLessThanOrEqual(63)
    expect(id).not.toContain(userId)
    expect(id).not.toContain(conversationId)
    expect(mocks.getSandbox).toHaveBeenCalledWith(
      expect.anything(), id, expect.objectContaining({ normalizeId: true })
    )
    const firstPath = first.sandbox.writeFile.mock.calls[0]?.[0]
    const secondPath = second.sandbox.writeFile.mock.calls[0]?.[0]
    expect(firstPath).toMatch(
      /^\/workspace\/runs\/[0-9a-f-]+\/run_analysis\.py$/u
    )
    expect(secondPath).not.toBe(firstPath)
  })

  it("uses different identities and unique directories concurrently", async () => {
    const first = sandboxFixture()
    const second = sandboxFixture()
    mocks.getSandbox
      .mockReturnValueOnce(first.sandbox)
      .mockReturnValueOnce(second.sandbox)
    await Promise.all([
      executeTool("user", "thread-a")({ task: "A", code: "print('a')" }, {
        toolCallId: "a",
      } as never),
      executeTool("user", "thread-b")({ task: "B", code: "print('b')" }, {
        toolCallId: "b",
      } as never),
    ])
    expect(mocks.getSandbox.mock.calls[0]?.[1]).not.toBe(
      mocks.getSandbox.mock.calls[1]?.[1]
    )
    expect(first.sandbox.writeFile.mock.calls[0]?.[0]).not.toBe(
      second.sandbox.writeFile.mock.calls[0]?.[0]
    )

    const boundaryA = sandboxFixture()
    const boundaryB = sandboxFixture()
    mocks.getSandbox.mockReturnValueOnce(boundaryA.sandbox).mockReturnValueOnce(boundaryB.sandbox)
    await executeTool("ab", "c")({ task: "A", code: "pass" }, { toolCallId: "c" } as never)
    await executeTool("a", "bc")({ task: "B", code: "pass" }, { toolCallId: "d" } as never)
    expect(mocks.getSandbox.mock.calls[2]?.[1]).not.toBe(mocks.getSandbox.mock.calls[3]?.[1])
  })

  it("launches argv with bounded output and a run-local output path, then supervises cleanup", async () => {
    const fixture = sandboxFixture()
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const result = await executeTool()(
      { task: "Calculate", code: "print('working')" },
      { toolCallId: "success" } as never
    )
    const pythonCall = fixture.exec.mock.calls.find(
      ([argv]) => argv[0] === "python3"
    )
    const cleanupCall = fixture.exec.mock.calls.find(
      ([argv]) => argv[0] === "rm"
    )
    expect(pythonCall?.[0]).toEqual([
      "python3",
      expect.stringMatching(/run_analysis\.py$/u),
    ])
    expect(pythonCall?.[1]).toMatchObject({
      timeout: 17_000,
      env: { PHOLIO_OUTPUT_PATH: expect.stringMatching(/output\.json$/u) },
    })
    expect(fixture.analysis.output).toHaveBeenCalledWith({
      encoding: "utf8",
      maxBytes: 256_000,
      timeout: 15_000,
      signal: undefined,
    })
    expect(cleanupCall?.[0]).toEqual([
      "rm",
      "-rf",
      "--",
      expect.stringMatching(/^\/workspace\/runs\//u),
    ])
    expect(result).toMatchObject({
      success: true,
      summary: "Calculated the return.",
      result: { returnPct: 12.5 },
    })
    expect(fixture.sandbox).not.toHaveProperty("destroy")
  })

  it("kills with SIGKILL and reaps when output is aborted", async () => {
    const controller = new AbortController()
    const analysis = processHandle(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true }
          )
        })
    )
    const fixture = sandboxFixture({ analysis })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "print('working')" },
      { abortSignal: controller.signal, toolCallId: "abort-output" } as never
    )
    await vi.waitFor(() => expect(analysis.output).toHaveBeenCalled())
    controller.abort(new DOMException("Stopped by user", "AbortError"))
    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(analysis.kill).toHaveBeenCalledWith(9)
    expect(analysis.waitForExit).toHaveBeenCalledWith({ timeout: 500 })
  })

  it("kills and reaps a process admitted after abort during launch", async () => {
    const controller = new AbortController()
    const fixture = sandboxFixture()
    let resolveLaunch!: (value: ReturnType<typeof processHandle>) => void
    const delayedLaunch = new Promise<ReturnType<typeof processHandle>>(
      (resolve) => {
        resolveLaunch = resolve
      }
    )
    fixture.exec.mockImplementation(
      async (argv: ReadonlyArray<string>, _options?: unknown) => {
        if (argv[0] === "mkdir") return fixture.mkdir
        if (argv[0] === "rm") return fixture.cleanup
        return delayedLaunch
      }
    )
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "print('working')" },
      { abortSignal: controller.signal, toolCallId: "abort-launch" } as never
    )
    await vi.waitFor(() =>
      expect(fixture.exec).toHaveBeenCalledWith(
        expect.arrayContaining(["python3", expect.any(String)]),
        expect.anything()
      )
    )
    controller.abort(new DOMException("Stopped by user", "AbortError"))
    resolveLaunch(fixture.analysis)
    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(fixture.analysis.kill).toHaveBeenCalledWith(9)
    expect(fixture.analysis.waitForExit).toHaveBeenCalled()
  })

  it("bounds observation when a cancelled launch never settles", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = sandboxFixture()
    fixture.exec.mockImplementation(async (argv: ReadonlyArray<string>) => {
      if (argv[0] === "mkdir") return fixture.mkdir
      if (argv[0] === "rm") return fixture.cleanup
      return new Promise<never>(() => undefined)
    })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "pass" },
      { abortSignal: controller.signal, toolCallId: "never-launch" } as never
    )
    await vi.waitFor(() => expect(fixture.exec).toHaveBeenCalledTimes(2))
    const rejected = expect(execution).rejects.toMatchObject({ name: "AbortError" })
    controller.abort(new DOMException("Stopped", "AbortError"))
    await vi.advanceTimersByTimeAsync(5_001)
    await rejected
  })

  it("defers termination and cleanup when a launch settles after the foreground window", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cleanup = processHandle(() => new Promise<never>(() => undefined))
    const fixture = sandboxFixture({ cleanup })
    const deferred: Array<Promise<void>> = []
    let resolveLaunch!: (value: ReturnType<typeof processHandle>) => void
    const delayedLaunch = new Promise<ReturnType<typeof processHandle>>((resolve) => {
      resolveLaunch = resolve
    })
    fixture.exec.mockImplementation(async (argv: ReadonlyArray<string>) => {
      if (argv[0] === "mkdir") return fixture.mkdir
      if (argv[0] === "rm") return fixture.cleanup
      return delayedLaunch
    })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool("user", "thread", undefined, (task) => deferred.push(task))(
      { task: "Calculate", code: "pass" },
      { abortSignal: controller.signal, toolCallId: "late-launch" } as never
    )
    await vi.waitFor(() => expect(fixture.exec).toHaveBeenCalledTimes(2))
    const abortedAt = Date.now()
    const rejected = expect(execution).rejects.toMatchObject({ name: "AbortError" })
    controller.abort(new DOMException("Stopped", "AbortError"))
    await vi.advanceTimersByTimeAsync(3_001)
    await rejected
    expect(Date.now() - abortedAt).toBeLessThanOrEqual(5_000)
    expect(deferred).toHaveLength(1)
    resolveLaunch(fixture.analysis)
    await vi.waitFor(() => expect(cleanup.output).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(3_001)
    await Promise.all(deferred)
    expect(fixture.analysis.kill).toHaveBeenCalledWith(9)
    expect(fixture.exec.mock.calls.filter(([argv]) => argv[0] === "rm")).toHaveLength(2)
  })

  it("bounds kill and reap when both RPCs never settle", async () => {
    vi.useFakeTimers()
    const analysis = processHandle(async () => {
      throw new mocks.ProcessWaitTimeoutError("local timeout")
    })
    analysis.kill.mockImplementation(() => new Promise<never>(() => undefined))
    analysis.waitForExit.mockImplementation(() => new Promise<never>(() => undefined))
    const fixture = sandboxFixture({ analysis })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "pass" },
      { toolCallId: "never-stop" } as never
    )
    await vi.waitFor(() => expect(analysis.kill).toHaveBeenCalled())
    const rejected = expect(execution).rejects.toMatchObject({ details: { category: "timeout" } })
    await vi.advanceTimersByTimeAsync(5_001)
    await rejected
  })

  it("kills and reaps on a local output timeout", async () => {
    const analysis = processHandle(async () => {
      throw new mocks.ProcessWaitTimeoutError("local timeout")
    })
    const fixture = sandboxFixture({ analysis })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "print('working')" }, {
        toolCallId: "timeout",
      } as never)
    ).rejects.toMatchObject({
      message: "Analysis execution exceeded its local wait limit.",
      details: { category: "timeout" },
    })
    expect(analysis.kill).toHaveBeenCalledWith(9)
    expect(analysis.waitForExit).toHaveBeenCalled()
  })

  it("enforces the 15 second local output deadline before the remote backstop", async () => {
    vi.useFakeTimers()
    const analysis = processHandle(() => new Promise<never>(() => undefined))
    const fixture = sandboxFixture({ analysis })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "pass" },
      { toolCallId: "local-deadline" } as never
    )
    const rejected = expect(execution).rejects.toMatchObject({
      mode: "recoverable",
      message: "Analysis process output timed out after 15000ms",
    })
    await vi.waitFor(() => expect(analysis.output).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(analysis.kill).toHaveBeenCalledWith(9)
    expect(analysis.output).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15_000 }))
  })

  it("reports remote timeout, truncation, and nonzero exits safely", async () => {
    const cases = [
      {
        output: {
          stdout: "",
          stderr: "",
          exitCode: 137,
          timedOut: true,
          truncated: false,
        },
        message: "Python execution reached its time limit.",
      },
      {
        output: {
          stdout: "payload",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          truncated: true,
        },
        message: "Python execution output exceeded the allowed size.",
      },
      {
        output: {
          stdout: "private stdout",
          stderr: "private traceback",
          exitCode: 2,
          timedOut: false,
          truncated: false,
        },
        message: "Python execution exited with code 2. private traceback",
      },
    ] satisfies Array<{ output: Output; message: string }>
    for (const testCase of cases) {
      const fixture = sandboxFixture({
        analysis: processHandle(testCase.output),
      })
      mocks.getSandbox.mockReturnValueOnce(fixture.sandbox)
      await expect(
        executeTool()({ task: "Calculate", code: "print('working')" }, {
          toolCallId: "failure",
        } as never)
      ).rejects.toMatchObject({
        message: testCase.message,
        name: "AgentToolError",
      })
    }
  })

  it("returns sanitized Python and output-schema guidance without logging it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const syntax = sandboxFixture({
      analysis: processHandle({
        stdout: "",
        stderr: "SyntaxError: invalid syntax API_TOKEN=super-secret-token-value",
        exitCode: 1,
        timedOut: false,
        truncated: false,
      }),
    })
    mocks.getSandbox.mockReturnValueOnce(syntax.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "bad python" }, { toolCallId: "syntax" } as never)
    ).rejects.toMatchObject({
      message: expect.stringContaining("SyntaxError: invalid syntax API_TOKEN=[REDACTED]"),
    })

    const schema = sandboxFixture({
      readContent: JSON.stringify({ summary: "", result: {} }),
    })
    mocks.getSandbox.mockReturnValueOnce(schema.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "pass" }, { toolCallId: "schema" } as never)
    ).rejects.toMatchObject({
      message: expect.stringContaining("Analysis output was invalid:"),
      details: { category: "invalid_output" },
    })
    expect(info.mock.calls.flat().join("\n")).not.toContain("super-secret-token-value")
  })

  it("maps preview lifecycle, transport, capacity, and protocol failures to safe contracts", async () => {
    const cases = [
      [
        new mocks.ContainerUnavailableError({
          code: "CONTAINER_UNAVAILABLE",
          message: "raw capacity detail",
          context: { reason: "container_starting", retryable: true, retryAfterMs: 12_345 },
        }),
        "Analysis capacity is temporarily unavailable.",
        "capacity",
      ],
      [
        new mocks.OperationInterruptedError({
          code: "OPERATION_INTERRUPTED",
          message: "raw interrupted detail",
          context: { reason: "runtime_replaced", operation: "process.exec", admitted: true, retryable: false },
        }),
        "The analysis workspace was interrupted.",
        "interrupted",
      ],
      [
        new mocks.RPCTransportError({
          code: "RPC_TRANSPORT_ERROR",
          message: "raw rpc detail",
          context: { kind: "peer_closed" },
        }),
        "The analysis workspace connection was interrupted.",
        "rpc",
      ],
      [
        new mocks.RuntimeControlProtocolError({
          code: "INTERNAL_ERROR",
          message: "raw protocol detail",
          context: {},
        }),
        "The analysis runtime is temporarily unavailable.",
        "protocol",
      ],
    ] as const
    for (const [error, message, category] of cases) {
      const fixture = sandboxFixture({ execError: error })
      mocks.getSandbox.mockReturnValueOnce(fixture.sandbox)
      const expectation = expect(
        executeTool()({ task: "Calculate", code: "print('working')" }, {
          toolCallId: "sandbox-error",
        } as never)
      ).rejects
      await expectation.toMatchObject({ message, details: { category } })
    }
  })

  it("preserves bounded capacity retry context and interruption retryability", async () => {
    const capacity = sandboxFixture({
      execError: new mocks.ContainerUnavailableError({
        code: "CONTAINER_UNAVAILABLE",
        message: "capacity",
        context: { reason: "container_starting", retryable: true, retryAfterMs: 999_999_999 },
      }),
    })
    mocks.getSandbox.mockReturnValueOnce(capacity.sandbox)
    await expect(
      executeTool()({ task: "A", code: "pass" }, { toolCallId: "capacity" } as never)
    ).rejects.toMatchObject({
      mode: "recoverable",
      details: { category: "capacity", retryAfterMs: 86_400_000 },
    })

    for (const retryable of [true, false]) {
      const interrupted = sandboxFixture({
        execError: new mocks.OperationInterruptedError({
          code: "OPERATION_INTERRUPTED",
          message: "interrupted",
          context: { reason: "runtime_replaced", operation: "process.exec", admitted: true, retryable },
        }),
      })
      mocks.getSandbox.mockReturnValueOnce(interrupted.sandbox)
      await expect(
        executeTool()({ task: "A", code: "pass" }, { toolCallId: "interrupted" } as never)
      ).rejects.toMatchObject({ mode: retryable ? "recoverable" : "terminal" })
    }
  })

  it("never lets cleanup failure mask success or the primary failure", async () => {
    const cleanupFailure = processHandle({
      stdout: "",
      stderr: "cleanup secret",
      exitCode: 1,
      timedOut: false,
      truncated: false,
    })
    const success = sandboxFixture({ cleanup: cleanupFailure })
    mocks.getSandbox.mockReturnValueOnce(success.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "print('working')" }, {
        toolCallId: "cleanup-success",
      } as never)
    ).resolves.toMatchObject({ success: true })

    const primary = sandboxFixture({
      analysis: processHandle({
        stdout: "",
        stderr: "primary secret",
        exitCode: 3,
        timedOut: false,
        truncated: false,
      }),
      cleanup: cleanupFailure,
    })
    mocks.getSandbox.mockReturnValueOnce(primary.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "print('working')" }, {
        toolCallId: "cleanup-failure",
      } as never)
    ).rejects.toMatchObject({ message: "Python execution exited with code 3. primary secret" })
  })

  it("kills and reaps cleanup on a local cleanup timeout", async () => {
    const cleanup = processHandle(async () => {
      throw new mocks.ProcessWaitTimeoutError("cleanup timeout")
    })
    const fixture = sandboxFixture({ cleanup })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    await expect(
      executeTool()({ task: "Calculate", code: "print('working')" }, {
        toolCallId: "cleanup-timeout",
      } as never)
    ).resolves.toMatchObject({ success: true })
    expect(cleanup.kill).toHaveBeenCalledWith(9)
    expect(cleanup.waitForExit).toHaveBeenCalled()
  })

  it("bounds cleanup when its output, kill, and reap never settle", async () => {
    vi.useFakeTimers()
    const cleanup = processHandle(() => new Promise<never>(() => undefined))
    cleanup.kill.mockImplementation(() => new Promise<never>(() => undefined))
    cleanup.waitForExit.mockImplementation(() => new Promise<never>(() => undefined))
    const fixture = sandboxFixture({ cleanup })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool()(
      { task: "Calculate", code: "pass" },
      { toolCallId: "never-cleanup" } as never
    )
    await vi.waitFor(() => expect(cleanup.output).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(5_001)
    await expect(execution).resolves.toMatchObject({ success: true })
  })

  it("returns promptly on upload abort and defers cleanup until the upload settles", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fixture = sandboxFixture()
    const deferred: Array<Promise<void>> = []
    let resolveWrite!: () => void
    fixture.sandbox.writeFile.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        resolveWrite = () => resolve(undefined)
      })
    )
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const execution = executeTool("user", "thread", undefined, (task) => deferred.push(task))(
      { task: "Calculate", code: "pass" },
      { abortSignal: controller.signal, toolCallId: "delayed-upload" } as never
    )
    await vi.waitFor(() => expect(fixture.sandbox.writeFile).toHaveBeenCalled())
    const abortedAt = Date.now()
    const rejected = expect(execution).rejects.toMatchObject({ name: "AbortError" })
    controller.abort(new DOMException("Stopped", "AbortError"))
    await rejected
    expect(Date.now() - abortedAt).toBeLessThanOrEqual(5_000)
    expect(fixture.exec.mock.calls.filter(([argv]) => argv[0] === "rm")).toHaveLength(1)
    expect(deferred).toHaveLength(1)
    resolveWrite()
    await Promise.all(deferred)
    expect(fixture.exec.mock.calls.filter(([argv]) => argv[0] === "rm")).toHaveLength(2)
  })

  it("does not add another upload wait after the foreground upload timeout", async () => {
    vi.useFakeTimers()
    const fixture = sandboxFixture()
    const deferred: Array<Promise<void>> = []
    let resolveWrite!: () => void
    fixture.sandbox.writeFile.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        resolveWrite = () => resolve(undefined)
      })
    )
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const startedAt = Date.now()
    const execution = executeTool("user", "thread", undefined, (task) => deferred.push(task))(
      { task: "Calculate", code: "pass" },
      { toolCallId: "upload-timeout" } as never
    )
    const rejected = expect(execution).rejects.toMatchObject({
      message: "Timed out writing analysis code after 20000ms",
    })
    await vi.waitFor(() => expect(fixture.sandbox.writeFile).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(20_001)
    await rejected
    expect(Date.now() - startedAt).toBeLessThan(25_000)
    expect(fixture.exec.mock.calls.filter(([argv]) => argv[0] === "rm")).toHaveLength(1)
    resolveWrite()
    await Promise.all(deferred)
    expect(fixture.exec.mock.calls.filter(([argv]) => argv[0] === "rm")).toHaveLength(2)
  })

  it("reports product phases without changing the final result", async () => {
    const fixture = sandboxFixture()
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    const reportProgress = vi.fn()
    const output = await executeTool(
      "user-1",
      "thread-1",
      reportProgress
    )({ task: "Calculate", code: "print('working')" }, {
      toolCallId: "progress",
    } as never)
    expect(reportProgress.mock.calls.map(([event]) => event)).toEqual([
      { toolCallId: "progress", phase: "provisioning" },
      { toolCallId: "progress", phase: "uploading" },
      { toolCallId: "progress", phase: "running" },
      { toolCallId: "progress", phase: "reading" },
    ])
    expect(output).not.toHaveProperty("progress")
  })

  it("does not log payloads or raw errors", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const fixture = sandboxFixture({
      analysis: processHandle({
        stdout: "PRIVATE_STDOUT",
        stderr: "PRIVATE_STDERR",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      }),
      readContent: JSON.stringify({
        summary: "PRIVATE_SUMMARY",
        result: { secret: "PRIVATE_RESULT" },
      }),
    })
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    await executeTool()({ task: "PRIVATE_TASK", code: "PRIVATE_CODE" }, {
      toolCallId: "payload-log",
    } as never)
    const logs = info.mock.calls.flat().join("\n")
    for (const forbidden of [
      "PRIVATE_TASK",
      "PRIVATE_CODE",
      "PRIVATE_SUMMARY",
      "PRIVATE_STDOUT",
      "PRIVATE_STDERR",
      "PRIVATE_RESULT",
      "token",
      "result",
      "details",
    ]) {
      expect(logs).not.toContain(forbidden)
    }
  })

  it("emits one non-preliminary final result through the real AI SDK protocol", async () => {
    const fixture = sandboxFixture()
    mocks.getSandbox.mockReturnValue(fixture.sandbox)
    let call = 0
    const usage = {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    }
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1
        return call === 1
          ? {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  {
                    type: "tool-call",
                    toolCallId: "analysis-call",
                    toolName: "analysis_run_code",
                    input: JSON.stringify({
                      task: "Calculate",
                      code: "print('ok')",
                    }),
                  },
                  {
                    type: "finish",
                    finishReason: { unified: "tool-calls", raw: "tool-calls" },
                    usage,
                  },
                ],
              }),
            }
          : {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "text-1" },
                  { type: "text-delta", id: "text-1", delta: "Done." },
                  { type: "text-end", id: "text-1" },
                  {
                    type: "finish",
                    finishReason: { unified: "stop", raw: "stop" },
                    usage,
                  },
                ],
              }),
            }
      },
    })
    const result = streamText({
      model,
      prompt: "Calculate",
      tools: createAnalysisTools("user-1", "thread-1"),
      stopWhen: isStepCount(3),
    })
    const parts = []
    for await (const part of result.stream) parts.push(part)
    const toolResults = parts.filter((part) => part.type === "tool-result")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "analysis-call",
      output: {
        success: true,
        summary: "Calculated the return.",
        result: { returnPct: 12.5 },
      },
    })
    expect(toolResults[0]?.preliminary).not.toBe(true)
  })
})
