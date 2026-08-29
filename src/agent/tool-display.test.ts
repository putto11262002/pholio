import { describe, expect, it, vi } from "vitest"
import {
  toolLabel,
  toolLoadingMessage,
  toolResultMessage,
} from "./tool-display"
import type { ToolDisplay } from "./tool-display"

describe("tool display failure guard", () => {
  it("renders a normalized failure without calling the success formatter", () => {
    const formatter = vi.fn(() => { throw new Error("formatter expected success fields") })
    const display: ToolDisplay = { label: "Quote", loadingMessage: "Loading", resultMessage: formatter }
    const message = toolResultMessage(display, { success: false, message: "Quote provider is unavailable" })
    expect(message).toBe("Quote provider is unavailable")
    expect(formatter).not.toHaveBeenCalled()
  })
})

describe("safe tool display", () => {
  it("uses generic copy for unknown and incomplete inputs", () => {
    expect(toolLabel(undefined)).toBe("Tool")
    expect(toolLabel("unknown_tool")).toBe("Tool")
    expect(toolLoadingMessage("unknown_tool", { secret: "raw argument" })).toBe("Running a tool…")
    expect(toolLoadingMessage("market_get_quote", undefined)).toBe("Looking up a quote…")
    expect(toolLoadingMessage("market_get_quote", {})).not.toContain("undefined")
  })

  it("does not leak raw page arguments into loading copy", () => {
    expect(toolLoadingMessage("research_read_page", { url: "https://secret.example/path" }))
      .toBe("Reading a source page…")
  })

  it("contains formatter failures", () => {
    const display: ToolDisplay = {
      label: "Broken",
      loadingMessage: () => { throw new Error("partial input") },
      resultMessage: () => { throw new Error("partial output") },
    }
    expect(toolResultMessage(display, {})).toBe("Tool finished")
  })
})
