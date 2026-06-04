# WHYPE/USDC Active Market Making Playbook

## Capital Structure

```
Aave collateral:  HYPE + ETH  (long exposure — never touch)
Aave borrow:      USDC        (LP capital)
LP deployment:    WHYPE/USDC  (income engine)
Hard floor:       Aave HF > 1.8 at all times
```

The HYPE bag is the conviction trade. The LP is the carry on the borrow. Keep them mentally separate.

---

## Entry Rules

**Only enter when:**
- Price is near the **center** of a consolidation range — not after a pump
- Regime is range-bound (drift/vol < 0.5 over 30 days)
- Aave HF > 2.0 (buffer for correlated drawdown)

**Never enter:**
- After a sharp directional move
- When drift/vol > 0.5 — the AMM will systematically sell your HYPE and fees won't compensate
- When HF < 2.0 — correlated drops hit collateral and LP simultaneously

---

## Range Management

**Width:** ±15–17% from geometric center
Derived from WHYPE's ~5.8%/day vol. Narrow enough to concentrate fees, wide enough to give ~8–9 days before rerange is needed.

**Manage to the center — not the boundary.**

Divide the range into thirds:

```
[  LOWER THIRD  |  MIDDLE THIRD  |  UPPER THIRD  ]
   ← rerange        hold            rerange →
```

**Rerange trigger:** Price enters the outer third of the range — not the boundary. By the time you hit the boundary you've already degraded capital efficiency and are close to going out of range.

---

## Rerange Decision

At 150% APY the math is mechanical:

| Input | Value |
|---|---|
| Daily fee income | ~0.41% of position |
| DL cost per rerange | ~1.5–2.5% |
| Break-even holding period | ~4–5 days |
| Expected days in range | ~8–9 days |
| Expected profit per cycle | Fees (~3.7%) minus DL (~2%) = ~1.7% |

Every cycle >5 days is profitable. **Reranging is not a failure — it is the job.**

**Execution:**
1. Close position → receive WHYPE + USDC
2. Open new range centered at current price, same ±15–17% width
3. Don't wait for a "better price" — the opportunity cost is ~$11.79/day at current position size
4. Accept rerange cost as the fee for staying in business

---

## Regime Check (Monthly)

Fetch 30-day WHYPE price history. Calculate:
- `dailyDrift` = total log return / 30
- `dailyVol` = std dev of daily log returns
- `ratio` = dailyDrift / dailyVol

| Ratio | Regime | Action |
|---|---|---|
| < 0.5 | Range-bound | Full position, normal rerange discipline |
| 0.5 – 1.0 | Mild trend | Reduce position size 50%, widen range |
| > 1.0 | Strong trend | **Pause LP entirely. Just hold HYPE.** |

In a strong trend the AMM sells your HYPE into every pump. No fee rate compensates for that if you are long-term bullish on HYPE.

---

## Risk Management Triggers

**Check after any day WHYPE moves >8%:**

```
HF < 1.8?
├── YES → Close LP, repay borrow, rebuild HF first
└── NO  → Continue

Drift/vol > 1.0?
├── YES → Close LP, hold HYPE spot
└── NO  → Continue

Price in outer third of range?
├── YES → Rerange today
└── NO  → Hold
```

---

## Exit Rules

**Exit LP entirely when:**
- Drift/vol > 1.0 for 7+ consecutive days — trend is real, not noise
- Aave HF drops below 1.8 — risk management overrides income generation
- High-conviction HYPE breakout thesis — own the upside unencumbered, don't let the AMM sell it

**On exit:** Repay USDC borrow first. Then decide whether to redeploy or wait.

---

## The Structural Compromise

This strategy accepts one permanent tradeoff: **it sells HYPE into every pump.** At 150% APY on deployed size, fees dominate. If your HYPE conviction ever becomes strong enough that you expect >150% returns imminently, close the LP and own the move outright.

The strategy is not "hold HYPE forever." It is: **earn 150% APY until the regime says stop, then get out of the way.**

---

## Key Numbers (Current)

| Metric | Value |
|---|---|
| Position size | ~$2,869 |
| Daily fee income | ~$11.79 |
| Rerange DL cost | ~$52 |
| DL recovery time | ~4.4 days |
| Aave HF | 2.2 |
| Current regime | Range-bound (drift/vol = 0.24) |
| Rerange trigger price | ~$72 (upper) / ~$69 (lower) at new centered range |

---

## Immediate Action (as of last review)

Current position (tokenId 477015) is in the bottom 15% of its range — outer third trigger is active.

1. Close current LP
2. Open new range centered at ~$66, width ±16% → approximately **$55.50 – $76.50**
3. Cost: ~$52 DL, recovered by day 4–5
