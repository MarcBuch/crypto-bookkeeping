# WHYPE/USDC Active Market Making Playbook

## Capital Structure

```
Aave collateral:  HYPE + ETH  (long exposure — never touch)
Aave borrow:      USDC        (LP capital)
LP deployment:    WHYPE/USDC  (income engine)
Hard floor:       Aave HF > 1.8 at all times
```

The HYPE bag is the conviction trade. The LP is the carry on the borrow. Keep them mentally separate.

The LP capital is borrowed USDC. A healthy Aave HF means liquidation risk is controlled; it does **not** mean the borrowed USDC purchasing power is protected. If the LP converts USDC into WHYPE during a drawdown, the fee engine may still be solvent while the borrow capital has taken inventory risk.

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

**Default width:** ±15–17% from geometric center
Derived from WHYPE's ~5.8%/day vol. Narrow enough to concentrate fees, wide enough to give ~8–9 days before rerange is needed.

Use the default width only when the objective is normal fee maximization and price is near the center of a range.

When the objective is **fee income while preserving borrowed USDC purchasing power**, prefer a wider or downside-skewed range. The goal is to keep fee income active without allowing the remaining USDC to be quickly converted into WHYPE on a continued drawdown.

**Manage to the center — not the boundary.**

Divide the range into thirds:

```
[  LOWER THIRD  |  MIDDLE THIRD  |  UPPER THIRD  ]
   ← rerange        hold            rerange →
```

**Rerange trigger:** Price enters the outer third of the range — not the boundary. By the time you hit the boundary you've already degraded capital efficiency and are close to going out of range.

The trigger is not symmetric:
- **Upper third:** Rerange or reduce promptly. The AMM is selling WHYPE into strength, which conflicts with long-term bullish HYPE exposure.
- **Lower third:** Do not mechanically recenter tight. First decide whether the mandate is HYPE accumulation or borrowed-USDC preservation.
- **Lower third + HYPE accumulation mandate:** Holding is acceptable if HF is safe and the HYPE thesis is intact.
- **Lower third + borrowed-USDC preservation mandate:** Widen, reduce, or close. A tight recenter can keep buying WHYPE with borrowed USDC into weakness.

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

**Execution, normal fee-max mode:**
1. Close position → receive WHYPE + USDC
2. Open new range centered at current price, same ±15–17% width
3. Don't wait for a "better price" unless there is a defined signal — the opportunity cost is `position value × expected daily fee rate`
4. Accept rerange cost as the fee for staying in business

**Execution, borrowed-USDC preservation mode:**
1. Close position → receive WHYPE + USDC
2. Reopen wider or downside-skewed rather than tight-centered
3. Target a materially higher USDC share inside the new LP
4. If preserving USDC is more important than fee income, reduce LP size or repay borrow instead

Example range shapes:

| Shape | Approx Range | Use Case |
|---|---:|---|
| Tight centered ±16% | Center × 0.84 – center × 1.16 | Max fee density; accepts fast inventory conversion |
| Wide centered ±25% | Center × 0.75 – center × 1.25 | Balanced fee income and lower rerange frequency |
| Downside-skewed -25%/+15% | Center × 0.75 – center × 1.15 | Preferred when protecting borrowed USDC purchasing power |
| Defensive -30%/+15% | Center × 0.70 – center × 1.15 | Stronger USDC preservation; lower fee density |

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
├── YES → Check mandate: fee-max tight rerange, or borrowed-USDC preservation widen/reduce
└── NO  → Hold

Borrowed USDC being converted into WHYPE too quickly?
├── YES → Widen, reduce, close, or repay borrow
└── NO  → Continue
```

---

## Exit Rules

**Exit LP entirely when:**
- Drift/vol > 1.0 for 7+ consecutive days — trend is real, not noise
- Aave HF drops below 1.8 — risk management overrides income generation
- High-conviction HYPE breakout thesis — own the upside unencumbered, don't let the AMM sell it
- The mandate is borrowed-USDC preservation and the LP has become mostly WHYPE near the lower bound

**On exit:** Repay USDC borrow first. Then decide whether to redeploy or wait.

---

## The Structural Compromise

This strategy accepts two permanent tradeoffs:
- It sells HYPE into every pump.
- It buys HYPE into every dump using the USDC side of the LP.

At 150% APY on deployed size, fees can dominate during range-bound markets. But if the capital source is borrowed USDC, the downside conversion matters: the position can remain solvent while reducing the purchasing power of the borrowed capital.

The strategy is not "hold HYPE forever." It is: **earn high fee income while the regime and inventory mix stay aligned with the mandate, then get out of the way.**

---

## Review Checklist

| Check | Rule |
|---|---|
| Aave HF | Must stay above 1.8; prefer above 2.0 before entering or reranging |
| Regime | Drift/vol < 0.5 for full-size LP; reduce/widen above 0.5; pause above 1.0 |
| Range location | Middle third is healthy; outer third requires a mandate-aware decision |
| Inventory mix | If borrowed-USDC preservation is the mandate, avoid becoming mostly WHYPE near the lower bound |
| Fee income vs DL | Rerange only when expected fee income can recover DL and gas within the holding period |
| Market beta | If BTC/ETH are weak, treat lower-third WHYPE exposure more defensively |

---

## Decision Template

Use this sequence whenever reviewing the active position:

1. Confirm Aave HF is safely above the hard floor.
2. Recalculate 30-day drift/vol.
3. Locate current price inside the LP range.
4. Check current WHYPE/USDC inventory mix.
5. Decide the mandate: fee maximization, HYPE accumulation, or borrowed-USDC preservation.
6. Apply the corresponding action:
   - Fee maximization: tight or default-width rerange if the outer-third trigger is active.
   - HYPE accumulation: lower-third holding is acceptable if HF and thesis are intact.
   - Borrowed-USDC preservation: widen, reduce, close, or repay borrow before the LP becomes mostly WHYPE.

Do not put position-specific token IDs, ranges, prices, or balances in this playbook. Store live state in the tracker and regenerate it during each review.
