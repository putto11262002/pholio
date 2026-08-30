import { describe, expect, it, vi } from "vitest"

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
      { abortSignal: controller.signal } as never
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
})
