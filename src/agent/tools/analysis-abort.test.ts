import { describe, expect, it, vi } from "vitest"
import { isStepCount, streamText } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getSandbox: vi.fn(),
}))

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: mocks.getSandbox }))
vi.mock("cloudflare:workers", () => ({
  env: {
    ANALYSIS_SANDBOX: {},
    PHOLIO_API_BASE_URL: "https://example.test",
  },
}))
vi.mock("@/auth/api-token.server", () => ({
  createUserApiToken: vi.fn(async () => "token"),
}))

import { createAnalysisTools } from "./analysis.server"

describe("analysis tool cancellation", () => {
  it("passes the turn signal into Sandbox execution and rejects on abort", async () => {
    const controller = new AbortController()
    mocks.exec.mockImplementation(
      (_command, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true }
          )
        })
    )
    mocks.getSandbox.mockReturnValue({
      writeFile: vi.fn(async () => undefined),
      exec: mocks.exec,
      readFile: vi.fn(),
    })
    const execute = createAnalysisTools("user-1").analysis_run_code.execute
    if (!execute) throw new Error("analysis tool must be executable")

    const execution = execute(
      { task: "Calculate a return", code: "print('working')" },
      { abortSignal: controller.signal, toolCallId: "call-abort" } as never
    )
    await vi.waitFor(() => expect(mocks.exec).toHaveBeenCalled())

    controller.abort(new DOMException("Stopped by user", "AbortError"))

    await expect(execution).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signal: controller.signal,
      })
    )
  })

  it("reports product phases while returning the unchanged final analysis result", async () => {
    mocks.exec.mockResolvedValue({
      success: true,
      exitCode: 0,
      duration: 42,
      stdout: "",
      stderr: "",
    })
    mocks.getSandbox.mockReturnValue({
      writeFile: vi.fn(async () => undefined),
      exec: mocks.exec,
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ summary: "Calculated the return.", result: { returnPct: 12.5 } }),
      })),
    })
    const reportProgress = vi.fn()
    const execute = createAnalysisTools("user-1", reportProgress).analysis_run_code.execute
    if (!execute) throw new Error("analysis tool must be executable")
    const output = await execute(
      { task: "Calculate a return", code: "print('working')" },
      { toolCallId: "call-success" } as never,
    )
    expect(reportProgress.mock.calls.map(([event]) => event)).toEqual([
      { toolCallId: "call-success", phase: "provisioning" },
      { toolCallId: "call-success", phase: "uploading" },
      { toolCallId: "call-success", phase: "running" },
      { toolCallId: "call-success", phase: "reading" },
    ])
    expect(output).toMatchObject({
      success: true,
      durationMs: 42,
      summary: "Calculated the return.",
      result: { returnPct: 12.5 },
      artifacts: [],
      stdout: "",
      stderr: "",
    })
    expect(output).not.toHaveProperty("progress")
  })

  it("emits one non-preliminary final result through the real AI SDK protocol", async () => {
    mocks.exec.mockResolvedValue({ success: true, exitCode: 0, duration: 42, stdout: "", stderr: "" })
    mocks.getSandbox.mockReturnValue({
      writeFile: vi.fn(async () => undefined),
      exec: mocks.exec,
      readFile: vi.fn(async () => ({
        content: JSON.stringify({ summary: "Calculated the return.", result: { returnPct: 12.5 } }),
      })),
    })
    let call = 0
    const usage = {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    }
    const model = new MockLanguageModelV4({
      doStream: async () => {
        call += 1
        return call === 1
          ? { stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "tool-call", toolCallId: "analysis-call", toolName: "analysis_run_code", input: JSON.stringify({ task: "Calculate", code: "print('ok')" }) },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ] }) }
          : { stream: simulateReadableStream({ chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Done." },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ] }) }
      },
    })
    const result = streamText({
      model,
      prompt: "Calculate",
      tools: createAnalysisTools("user-1"),
      stopWhen: isStepCount(3),
    })
    const parts = []
    for await (const part of result.stream) parts.push(part)
    const toolResults = parts.filter((part) => part.type === "tool-result")

    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "analysis-call",
      output: { success: true, summary: "Calculated the return.", result: { returnPct: 12.5 } },
    })
    expect(toolResults[0]?.preliminary).not.toBe(true)
  })
})
