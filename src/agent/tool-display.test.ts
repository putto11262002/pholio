import { describe, expect, it, vi } from "vitest"
import { toolResultMessage, type ToolDisplay } from "./tool-display"

describe("tool display failure guard", () => {
  it("renders a normalized failure without calling the success formatter", () => {
    const formatter = vi.fn(() => { throw new Error("formatter expected success fields") })
    const display: ToolDisplay = { label: "Quote", loadingMessage: "Loading", resultMessage: formatter }
    const message = toolResultMessage(display, { success: false, message: "Quote provider is unavailable" })
    expect(message).toBe("Quote provider is unavailable")
    expect(formatter).not.toHaveBeenCalled()
  })
})
