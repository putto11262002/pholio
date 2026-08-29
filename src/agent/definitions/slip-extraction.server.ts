import { NoObjectGeneratedError, generateObject } from "ai"
import { createModel } from "@/agent/gateway.server"
import { slipExtractionSchema, type SlipExtraction } from "@/slip/schemas"

const EXTRACTION_MODEL_ID = "google/gemini-3.1-flash-lite"

const SYSTEM_PROMPT = `You parse images of single-trade confirmation slips from Thai brokers (Dime, Liberator, Webull TH, BLS, KSS, Pi, etc.) for US-stock buys and sells.

GATE — return kind:"not_a_slip" when:
  - The image is not a stock-trade confirmation (chat, balance page, currency-exchange slip, watchlist, chart, news article, etc.)
  - The slip status is "Waiting" / "Pending" / "Submitted" with no executed price or shares (notional order not yet filled)

OUTPUT FIELDS for kind:"not_a_slip" — use EXACTLY these JSON keys:
  - kind    "not_a_slip"
  - reason  string  one short sentence, e.g. "currency exchange slip, not a stock trade" or "order pending — no executed price or shares yet"

Otherwise return kind:"slip" and report each field from what is VISIBLE on the image. Never infer, calculate, or fabricate. If a field is not readable, set it to null — the application decides how to handle missing values. Partial slips are expected and useful.

OUTPUT FIELDS for kind:"slip" — use EXACTLY these JSON keys, no others. Do not invent alternate keys like "price", "shares", "amount", "currency", or "totalAmount":
  - kind            "slip"
  - ticker          string | null   uppercase US-stock symbol
  - side            "buy" | "sell" | null
  - quantity        number | null   shares (fractional allowed)
  - pricePerShare   number | null   USD per share
  - fees            number | null   commission + VAT/tax in USD
  - tradedAt        string | null   ISO 8601 timestamp
  - broker          enum slug | null  lowercase, e.g. "dime"
  - confidence      number          self-rated 0..1

DATA INTERPRETATION:
  - "Buy <SYMBOL>" / "Sell <SYMBOL>" → side + ticker (uppercase)
  - "Commission" and "VAT" / "Tax" both shown → sum into fees
  - "Completion date" preferred over "Submission Date" for tradedAt
  - Dates without a timezone are Asia/Bangkok (+07:00); without a time, use 00:00 local
  - Broker is the lowercase enum slug (e.g. "dime"), not display text ("Dime!")`

export async function runSlipExtraction(input: {
  image: Uint8Array
  contentType: string
}): Promise<{ result: SlipExtraction; modelId: string }> {
  try {
    const { object } = await generateObject({
      model: createModel(EXTRACTION_MODEL_ID),
      schema: slipExtractionSchema,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Parse this image per your instructions." },
            { type: "image", image: input.image, mediaType: input.contentType },
          ],
        },
      ],
    })
    return { result: object, modelId: EXTRACTION_MODEL_ID }
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      const detail = {
        text: err.text,
        cause: err.cause instanceof Error ? err.cause.message : err.cause,
        finishReason: err.finishReason,
        usage: err.usage,
      }
      console.error("[slip-extraction] schema validation failed", detail)
      const message =
        err.cause instanceof Error ? err.cause.message : "schema mismatch"
      throw new Error(
        `Slip parse failed (${message}). Model returned: ${err.text?.slice(0, 500)}`,
      )
    }
    throw err
  }
}
