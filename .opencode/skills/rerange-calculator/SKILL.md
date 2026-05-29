---
name: rerange-calculator
description: Use when the user wants to rerange a Uniswap V3-style LP position, is near the edge of their range, or wants to compare range width scenarios. Calculates token amounts, fee concentration, and in-range probability for multiple range scenarios using real volatility data from CoinGecko.
---

# Skill: Rerange Calculator

Calculates optimal rerange scenarios for a concentrated liquidity (Uniswap V3-style) LP position. Uses real price history to estimate volatility and drift, then models in-range probability and fee concentration for each scenario.

## When to use

- User's position is near the upper or lower range boundary
- User wants to rerange and needs to pick a range width
- User asks "how wide should my range be?"
- User wants to compare narrow vs wide vs asymmetric ranges

## Workflow

### Step 1: Get current position data
```bash
bun run apps/cli/src/index.ts --json positions 2>/dev/null
```
Extract: `currentPrice`, `priceLower`, `priceUpper`, `currentAmount0`, `currentAmount1`, `token0Symbol`, `token1Symbol`.

### Step 2: Fetch 30-day price history for both tokens from CoinGecko
Use WebFetch to get daily prices:
```
https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days=30&interval=daily
```
Common coin IDs: `hyperliquid` for HYPE, `bitcoin` for BTC, `ethereum` for ETH.

Compute the **ratio** of token0/token1 prices — this is what the LP tracks.

### Step 3: Compute volatility and drift
```javascript
// Daily log returns of the ratio
const logReturns = ratio.map((r, i) => i > 0 ? Math.log(r / ratio[i-1]) : null).filter(Boolean);
const mean = logReturns.reduce((a,b) => a+b, 0) / logReturns.length;
const variance = logReturns.reduce((a,b) => a + (b-mean)**2, 0) / (logReturns.length - 1);
const dailyVol = Math.sqrt(variance);
const dailyDrift = mean; // log drift per day
```

### Step 4: Calculate scenarios

For each scenario (symmetric ±10%, ±15%, ±20%, asymmetric variants):

**Token amounts** (V3 math):
```javascript
function calcAmounts(price, priceLower, priceUpper, totalValueToken1) {
  const sqrtP  = Math.sqrt(price);
  const sqrtPa = Math.sqrt(priceLower);
  const sqrtPb = Math.sqrt(priceUpper);
  const L = totalValueToken1 / ((sqrtP - sqrtPa) + (1/sqrtP - 1/sqrtPb) * price);
  return {
    amount0: L * (1/sqrtP - 1/sqrtPb),
    amount1: L * (sqrtP - sqrtPa)
  };
}
```

**In-range probability** (log-normal approximation with drift):
```javascript
function probInRange(pctUp, pctDown, days, dailyVol, dailyDrift) {
  const sigmaT = dailyVol * Math.sqrt(days);
  const driftT = dailyDrift * days;
  function normCDF(z) {
    const t = 1/(1+0.2316419*Math.abs(z));
    const d = 0.3989423*Math.exp(-z*z/2);
    const p = d*t*(0.3193815+t*(-0.3565638+t*(1.7814779+t*(-1.8212560+t*1.3302744))));
    return z > 0 ? 1-p : p;
  }
  const zUp   = (Math.log(1 + pctUp/100)   - driftT) / sigmaT;
  const zDown = (Math.log(1 - pctDown/100) - driftT) / sigmaT;
  return (normCDF(zUp) - normCDF(zDown)) * 100;
}
```

**Fee concentration vs full range**:
```javascript
const concentration = Math.sqrt(priceUpper/priceLower) / (Math.sqrt(priceUpper/priceLower) - 1);
```

### Step 5: Present results

Show a table with columns: Scenario | Lower | Upper | token0 amount | token1 amount | Fee concentration | In-range 3d / 7d / 14d

### Step 6: Recommendation logic

- If `|dailyDrift| * 7 > dailyVol * sqrt(7)` → strong trend detected, warn that any range will go out of range quickly; suggest narrow range + active reranging OR reconsidering LP entirely
- If drift is low relative to vol → symmetric range, width based on desired rerange frequency:
  - Rerange every ~7 days: use `±(dailyVol * sqrt(7) * 100)%`
  - Rerange every ~14 days: use `±(dailyVol * sqrt(14) * 100)%`
- If drift is directional → suggest asymmetric range skewed in drift direction, but flag the risk

## Key concepts

- **Fee concentration**: how much more fees you earn vs a full-range position. ±10% ≈ 10x, ±15% ≈ 7x, ±20% ≈ 5x.
- **In-range probability**: accounts for both volatility AND drift. A symmetric range in a trending market has much lower in-range probability than the width alone suggests.
- **Asymmetric range**: skew the range in the direction of momentum to reduce reranging frequency, at the cost of less downside buffer.
- **Rerange cost**: every rerange crystallizes divergence loss. Fewer reranges = less crystallized loss.

## Important notes

- Total value to redeploy = `currentAmount0 * currentPrice + currentAmount1`
- Always check how far price is from current range boundaries before recommending
- If position is already out of range, rerange is urgent — every hour out of range earns zero fees
- Token unlock events or known catalysts should override the pure volatility-based recommendation
