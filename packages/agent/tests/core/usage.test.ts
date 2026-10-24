import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, modelPricing, parseUsageTotals } from "../../src/core/usage.js";

test("prices, totals and saved totals follow the VS Code extension's rules", () => {
  assert.equal(modelPricing({ id: "free" }), undefined);
  assert.deepEqual(modelPricing({ input_cost_per_1m: 3, currency: "USD" }), { input: 3, currency: "USD" });
  assert.deepEqual(modelPricing({ inputCostPer1M: 1, outputCostPer1M: 4 }), { input: 1, output: 4, currency: "EUR" });

  const usage = { promptTokens: 2_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 };
  // No price: tokens count, the cost stays unknown instead of 0.
  const free = addUsage(undefined, usage, undefined);
  assert.deepEqual(free, { promptTokens: 2_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 });
  // Only an input price: output counts as 0; cached tokens are charged as input.
  assert.deepEqual(addUsage(free, usage, { input: 3, currency: "USD" }), {
    promptTokens: 4_000_000, completionTokens: 2_000_000, cachedTokens: 1_000_000, cost: 6, currency: "USD",
  });

  assert.equal(parseUsageTotals({ cost: 1 }), undefined);
  assert.deepEqual(parseUsageTotals({ promptTokens: 5, completionTokens: "x", cost: Infinity, currency: "" }), {
    promptTokens: 5, completionTokens: 0, cachedTokens: 0,
  });
});
