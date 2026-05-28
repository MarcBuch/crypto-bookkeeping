---
name: trend-vs-lp
description: Use when the user wants to know if LPing is worth it given the current market trend, asks whether to keep or close an LP position, or wants to simulate what happens to divergence loss if they keep reranging in a trending market. Compares LP P&L vs HODL under different trend scenarios.
---

# Skill: Trend vs LP Analyzer

Determines whether an LP position is working for or against you given the current price trend. Simulates the compounding effect of divergence loss under continuous reranging, and compares LP returns vs simply holding.

## When to use

- User asks "should I keep LPing or just hold?"
- User wants to understand if the trend makes LPing counterproductive
- User asks "what happens if I keep reranging in this trend?"
- User wants to know the break-even fee yield needed to justify LPing vs HODL

## Workflow

### Step 1: Get current position data
```bash
bun run src/index.ts --json pnl 2>/dev/null
```
Extract for the active position: `entryPrice`, `exitPrice` (current), `divergenceLossPercent`, `feesValueInToken1`, `entryValueInToken1`.

### Step 2: Fetch 30-day price history from CoinGecko
```
https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days=30&interval=daily
```
Compute the token0/token1 ratio. Calculate:
- `dailyVol`: standard deviation of daily log returns
- `dailyDrift`: mean daily log return
- Trend over 7d, 14d, 30d periods

### Step 3: Classify the market regime

| Condition | Regime |
|---|---|
| `abs(dailyDrift) < 0.5 * dailyVol` | Range-bound — LP favored |
| `0.5 * dailyVol <= abs(dailyDrift) < dailyVol` | Mild trend — LP marginal |
| `abs(dailyDrift) >= dailyVol` | Strong trend — HODL favored |

### Step 4: Simulate reranging in trend

Run the following simulation for the **current drift** and for **zero drift** (range-bound scenario):

```javascript
function simulateReranging(params) {
  const {
    initialValue,    // total capital in UBTC
    entryPrice,      // price at first entry
    dailyDrift,      // log drift per day
    dailyVol,        // daily volatility (unused in deterministic sim)
    rangeWidth,      // e.g. 0.15 for ±15%
    dailyFeeYield,   // e.g. 0.001 for 0.1%/day
    days             // simulation horizon
  } = params;

  let price = entryPrice;
  let lpValue = initialValue;
  let totalFees = 0;
  let reranges = 0;
  let lower = entryPrice * (1 - rangeWidth);
  let upper = entryPrice * (1 + rangeWidth);

  // HODL baseline: fixed token amounts from initial deposit
  const { amount0: hodlA0, amount1: hodlA1 } = calcAmountsAtPrice(entryPrice, lower, upper, initialValue);

  const snapshots = [];

  for (let day = 1; day <= days; day++) {
    price = price * Math.exp(dailyDrift);

    if (price > upper || price < lower) {
      // Crystallize DL, rerange
      const { amount0, amount1 } = calcAmountsAtPrice(price, lower, upper, lpValue);
      lpValue = amount0 * price + amount1;
      lower = price * (1 - rangeWidth);
      upper = price * (1 + rangeWidth);
      reranges++;
    }

    const fee = lpValue * dailyFeeYield;
    totalFees += fee;
    lpValue += fee;

    const hodlValue = hodlA0 * price + hodlA1;
    const { amount0: lp0, amount1: lp1 } = calcAmountsAtPrice(price, lower, upper, lpValue);
    const currentLpValue = lp0 * price + lp1;

    if (day % 5 === 0 || day === 1) {
      snapshots.push({ day, price, lpValue: currentLpValue, hodlValue, fees: totalFees, reranges });
    }
  }
  return snapshots;
}
```

### Step 5: Calculate break-even fee yield

The minimum daily fee yield needed for LP to match HODL:

```javascript
// After N days with drift d, HODL grows by exp(d*N)
// LP with DL grows by approximately exp(d*N) * (1 - DL_per_rerange * reranges)
// Break-even: fees must cover the DL gap
// Rough approximation:
const hodlReturn = Math.exp(dailyDrift * days) - 1;
const lpReturnWithoutFees = estimateLpReturnNoDrift(rangeWidth, dailyDrift, days);
const gap = hodlReturn - lpReturnWithoutFees;
const breakEvenDailyFee = gap / days; // simplified
```

### Step 6: Present findings

**Always show:**
1. Market regime classification with the drift/vol ratio
2. Simulation table: Day | LP Value | HODL Value | LP vs HODL % | Reranges
3. Break-even fee yield vs estimated actual fee yield
4. Clear verdict: LP favored / marginal / HODL favored

**Verdict logic:**
- If estimated daily fee yield > break-even → LP is justified
- If trend is strong AND drift direction is consistent across 7d/14d/30d → HODL strongly favored
- If trend is recent (only 7d, not 14d/30d) → trend may be temporary, LP still reasonable

## Key concepts

- **Divergence loss crystallization**: each rerange permanently locks in the DL from that period. In a trend, this compounds — you keep selling the winner and buying the loser.
- **Break-even fee yield**: the daily fee rate needed for LP returns to match HODL. In a strong trend this can be impossibly high (e.g., 2%/day).
- **Regime detection**: the drift/vol ratio is the key signal. When drift dominates vol, the AMM's rebalancing mechanism works against you systematically.
- **Reversibility**: DL before reranging is partially reversible (price could come back). DL after reranging is permanent.

## Estimated fee yields for reference

| Pool type | Typical daily fee yield |
|---|---|
| Stable/stable 0.05% | 0.01–0.05%/day |
| Blue-chip 0.3% (e.g. WHYPE/UBTC) | 0.05–0.15%/day |
| Volatile 1% | 0.1–0.3%/day |

These are rough estimates. Actual yield depends on pool volume and your share of liquidity.

## Important notes

- A strong trend does NOT mean LP is always wrong — if the trend reverses, LP recovers. The question is your conviction on trend continuation.
- Fees are real, guaranteed income. Divergence loss is opportunity cost. But in a strong trend, the opportunity cost can dwarf the fees.
- The simulation uses deterministic drift (no randomness). Real outcomes will vary — the simulation shows the expected value, not a guaranteed outcome.
