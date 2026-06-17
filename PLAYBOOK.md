# WHYPE/USDC Active Market Making Playbook

## Mandate (read first)

This account has exactly two objectives, in strict order:

1. **Capital preservation** — protect the USDC available to repay the borrow.
2. **Fee income** — earn carry on the deployed USDC, second to preservation.

**HYPE upside is not this account's job.** A separate account holds HYPE for capital
appreciation. Missing out on longs, selling WHYPE into a pump, or under-owning HYPE in a
rally are **not** concerns here. Do not reason about HYPE conviction in this book.

Two consequences fall directly out of this:

- **An uptrend is benign-to-good.** As price rises the AMM sells your WHYPE and hands you
  USDC. You end the cycle with more repayment capital plus fees. There is no upside to
  "protect" — so there is no reason to pause the fee engine in a rally.
- **A downtrend is the only real threat.** As price falls the AMM buys WHYPE with your
  borrowed USDC, leaving you holding inventory worth less than you owe. Every defensive
  rule in this document exists to manage *this* case.

There is no "HYPE accumulation" mandate in this account. Lower-third WHYPE inventory is
never held because the HYPE thesis is intact — that thesis lives elsewhere.

---

## Ideal Position Profile

The target is a **low-touch, wide-range, structurally-hedged position held >7 days.**

- **Wide range by default.** Fewer reranges, more days in range, less divergence-loss
  churn, and slow delta change (low gamma) so a hedge needs rebalancing rarely.
- **Structural hedge by default.** Because we don't care about HYPE upside, we can hold a
  standing short against the LP's WHYPE delta and run the position close to delta-reduced.
  Fees + funding carry it; the hedge caps the downside conversion risk.
- **Little management.** Define triggers at range thirds, not at every tick. A healthy
  position should need a human look roughly weekly, not daily.

If a position would require frequent recentering or constant hedge rebalancing to stay
safe, it is the wrong position — widen it, shrink it, or don't open it.

---

## Capital Structure

```
Aave collateral:  HYPE + ETH  (long exposure — other account's concern, never touch here)
Aave borrow:      USDC        (LP capital)
LP deployment:    WHYPE/USDC  (income engine)
Hard floor:       Aave HF > 1.8 at all times
```

The preservation metric is **USDC available to repay the borrow** — *not* Aave HF and
*not* USD equity (equity is dominated by HYPE collateral that belongs to the other book).
The LP can remain solvent on HF while quietly converting borrowed USDC into WHYPE at a
loss. That is the failure this account is built to avoid.

**Correlated double-hit is the tail risk:** in a sharp drop, HYPE/ETH collateral falls
*and* the LP converts to WHYPE simultaneously. HF and repayment capital degrade together.

---

## Entry Rules

**Primary preservation lever is size.** Before range shape or hedging, decide how much
USDC to deploy. A smaller LP has proportionally smaller downside conversion risk and a
smaller hedge to manage. When in doubt, deploy less or repay borrow.

**Only enter when:**
- Regime is range-bound or recovering — not in a confirmed downtrend (see Regime Check)
- Aave HF > 2.0 (buffer for correlated drawdown)
- You can open **wide** and, preferably, **downside-skewed** so price sits in the upper
  portion of the range → you start mostly USDC with skew absorbing a drop

**Never enter:**
- Into a confirmed downtrend (negative drift/vol below ~−0.5) — you'd be buying WHYPE all
  the way down with borrowed USDC
- When HF < 2.0 — correlated drops hit collateral and LP at once
- With a tight, fully-centered range as the default — that hands you ~50% WHYPE inventory
  on day one

A strong *uptrend* is not a reason to stay out; it simply means the LP will shed WHYPE for
USDC, which is fine here.

---

## Range Management

**Default shape: wide, slightly downside-skewed.** Tight-centered is the *exception*, used
only when a low-vol range-bound regime is confirmed and the explicit objective is short-term
fee density.

| Shape | Approx Range | Use Case |
|---|---:|---|
| **Wide centered ±25% (default)** | center × 0.75 – center × 1.25 | Low-touch, >7-day holds, balanced fee income |
| **Downside-skewed −30%/+20% (preferred)** | center × 0.70 – center × 1.20 | Preservation-first: start mostly USDC, slow downside conversion |
| Defensive −35%/+15% | center × 0.65 – center × 1.15 | Strong USDC preservation in a soft tape; lower fee density |
| Tight centered ±16% (exception) | center × 0.84 – center × 1.16 | Confirmed low-vol range only; accepts fast inventory conversion and frequent reranges |

**Manage to keep the USDC share healthy — not to keep price centered.** Centering is a
fee-max reflex. Letting price ride in the upper portion of the range (where the LP is more
USDC) is exactly what this account wants.

Divide the range into thirds, and treat the two sides **asymmetrically**:

```
[  LOWER THIRD  |  MIDDLE THIRD  |  UPPER THIRD  ]
   ← defend          hold           fee-continuity only →
```

- **Upper third — no inventory urgency.** The AMM selling WHYPE into strength *builds the
  USDC you want*. The only reason to act here is mechanical: if price is about to leave the
  range and stop earning fees, rerange up to keep the engine on. There is no rush.
- **Middle third — hold.** This is the resting state. Do nothing.
- **Lower third — defend.** This is the threat side. Do **not** mechanically recenter tight,
  which just buys more WHYPE with borrowed USDC into weakness. Choose from: widen, reduce,
  add/extend the structural hedge, close, or repay borrow.

---

## Rerange Decision

A wide position should clear the >7-day target comfortably. Reranging is a normal cost of
staying in business — **but only when the resulting inventory mix is acceptable.** Do not
mechanically rerange just to keep fees flowing if it re-converts USDC into WHYPE in a weak
tape; in that case reduce or repay instead.

**Rerange trigger:** price enters the *upper* third (fee-continuity) or the *lower* third
(defensive decision) — not the boundary. By the boundary you've already lost efficiency.

**Execution — default (wide / skewed):**
1. Close position → receive WHYPE + USDC
2. Reopen **wide and downside-skewed**, sized to keep a healthy USDC share
3. Re-establish or resize the structural hedge to the new mid-range WHYPE delta
4. Confirm the new position can plausibly hold >7 days before touching it again

**Execution — preservation override:**
1. If price is weak and inventory is drifting to WHYPE, do **not** rerange to stay in.
2. Reduce LP size or repay borrow first.
3. Only redeploy once regime is no longer a confirmed downtrend.

Illustrative economics (range-bound, ~150% APY): ~0.41%/day fees, ~1.5–2.5% DL per
rerange, ~4–5 day break-even. Wide ranges trade some fee density for far fewer reranges and
much lower management — the right trade for this mandate.

---

## Regime Check (Monthly) — sign-aware

Fetch 30-day WHYPE price history. Calculate:
- `dailyDrift` = total log return / 30  *(keep the sign)*
- `dailyVol` = std dev of daily log returns
- `ratio` = dailyDrift / dailyVol

Because preservation only fears downside, the response is **asymmetric on the sign of drift:**

| Ratio | Regime | Action |
|---|---|---|
| > +0.5 (up-trend) | Rising | **Keep earning, full size.** The LP sheds WHYPE for USDC — aligned with the mandate. Do not pause. |
| −0.5 to +0.5 | Range-bound | Full position, wide range, normal rerange discipline. |
| −1.0 to −0.5 (down-trend) | Soft | Reduce size, widen/skew down, run or extend the structural hedge. |
| < −1.0 (strong down-trend) | Dangerous | **Reduce hard or stand aside.** This is the regime that buys WHYPE all the way down with borrowed USDC. Close, repay, or hedge as a bridge to exit. |

Note the contrast with a HYPE-upside book: this account does **not** pause LP in a strong
*uptrend*. It pauses (or defends) in a strong *downtrend*.

---

## Risk Management Triggers

**Check after any day WHYPE moves >8%:**

```
HF < 1.8?
├── YES → Close LP, repay borrow, rebuild HF first
└── NO  → Continue

Drift/vol < −1.0 (strong downtrend)?
├── YES → Reduce hard / close / hedge as bridge to exit
└── NO  → Continue

Price in LOWER third of range?
├── YES → Defend: widen, reduce, hedge, close, or repay (never tight-recenter)
└── NO  → Continue

Borrowed USDC being converted into WHYPE too quickly?
├── YES → Widen, reduce, close, repay, or add structural hedge
└── NO  → Continue
```

A strong *uptrend* or price in the *upper* third does not trigger defensive action — at
most a mechanical rerange-up to keep fees on.

---

## Hedge / Short Rules

In this account a hedge is **not** a directional bet (the HYPE view lives elsewhere) and,
given the low-touch wide-range mandate, it is a **preferred structural tool**, not only an
emergency measure. There are two distinct hedge modes.

### Mode A — Structural hedge (preferred, standing)

A standing short sized against the LP's WHYPE delta, paired with a wide range, to run a
low-management, delta-reduced position that earns **fees + funding carry** while capping
downside conversion.

- **Why it works here:** we don't care about HYPE upside, so giving up the LP's upside
  participation via a short costs us nothing we value, while it directly protects repayment
  capital on the downside.
- **Sizing:** hedge **50–75% of current LP WHYPE delta** — partial neutrality, not full.
  Never exceed 100% of current WHYPE delta; beyond that the short is naked directional and
  prohibited.
- **Low-touch rebalancing:** because the range is wide, delta changes slowly. **Rebalance
  only when price crosses into a new third**, not continuously. Accept residual delta
  between rebalances. As the LP sheds WHYPE near the top, **trim the short** so it never
  becomes naked.
- **Funding:** when funding is positive (longs pay shorts) the structural hedge earns carry
  and complements fee income — a tailwind for keeping it on. Negative funding is the main
  ongoing cost; monitor it against fee income and shrink the hedge if carry erodes the edge.
- **Accepted cost:** in a sharp uptrend the hedged LP underperforms an unhedged LP (the
  short loses while the LP sells WHYPE). That is acceptable — preservation is intact and the
  forgone upside is not this account's objective.

### Mode B — Tactical insurance hedge (emergency bridge)

Used when downside conversion risk spikes and you need to cap loss while deciding to close,
reduce, or repay. This keeps the original strict discipline:

- **Set the stop first, then size the short.** Never size first and hunt for a convenient
  stop. (Jun 12 failure mode: oversized short, noise-level stop, closed −$98.56.)
- **Valid stops:** 7d structural high + 1%; 1.5σ vol stop (`entry × (1 + 1.5 × dailyVol)`);
  LP range invalidation level; recent market-structure high.
- **Invalid stops:** inside intraday noise; chosen only to make the hedge look profitable;
  risking more than fees can recover.
- **Max loss at the stop ≤ 7 days of expected LP fee income** (prefer ≤ 3–5 days).
- A tactical hedge must **not** become permission to keep an LP open when the mandate says
  the inventory is wrong. First response to unwanted WHYPE remains: close/reduce, then
  repay/wait flat, then hedge only if immediate exit is impractical.

### Hedge Decision Matrix

| LP State | Hedge Action |
|---|---|
| Mostly USDC near upper bound | **No hedge / trim to ~0.** A short here is naked. |
| Wide range, balanced inventory, range-bound | **Run Mode A** at 50–75% of WHYPE delta — this is the default operating posture. |
| Lower third, WHYPE inventory rising | Extend Mode A toward 75%, or switch to Mode B as a bridge to reduce/close. |
| Mostly WHYPE near lower bound | Mode B bridge to close/reduce/repay — do not use it to justify staying. |
| Strong downtrend + meaningful WHYPE delta | Hedge (up to ~75% of current delta) or close outright. |
| Strong uptrend + LP mostly USDC | **No hedge** — would be naked directional exposure. |

### Hedge Exit / Resize Rules

Reduce or close the hedge when **any** of:
- The LP is closed or reranged and delta materially changes (resize to new delta)
- Price crosses into a new third (rebalance to target % of current WHYPE delta)
- LP inventory becomes mostly USDC (trim toward zero — avoid naked short)
- Mode B: price reaches the stop, or loss hits the fee-budget limit
- Funding turns persistently negative and erodes the fee edge

### Post-Hedge Retrospective

After every hedge close, classify it. The point is to keep hedging tied to inventory risk,
not to lucky direction.

| Worth it? | Regime justified it? | Classification |
|---|---|---|
| Yes | Yes | Correct hedge — inventory risk supported it and it paid off |
| Yes | No | Profitable directional call — **do not promote to a rule** |
| No | Yes | Valid signal, wrong timing or reversal |
| No | No | Correct skip — regime and outcome both said no |

---

## Exit Rules

**Exit LP entirely when:**
- Drift/vol < −1.0 for 7+ consecutive days — the downtrend is real, not noise
- Aave HF drops below 1.8 — risk management overrides income
- The LP has become mostly WHYPE near the lower bound and preservation is threatened

A strong *uptrend* is **not** an exit signal for this account — the LP simply converts to
USDC, which is the outcome we want.

**On exit:** repay USDC borrow first. Then decide whether to redeploy or wait.

---

## The Structural Compromise

This strategy accepts two permanent tradeoffs:
- It sells WHYPE into every pump — **fine here**, that builds repayment USDC.
- It buys WHYPE into every dump using the USDC side — **this is the risk to manage**, via
  wide/skewed ranges, conservative size, and the structural hedge.

At ~150% APY fees can dominate in range-bound markets. Because the capital is borrowed USDC,
the strategy is not "hold WHYPE forever." It is: **earn fee + funding income from a wide,
hedged, low-touch position while the regime stays out of a strong downtrend, then get out of
the way.**

---

## Review Checklist

| Check | Rule |
|---|---|
| Size first | Deploy only as much borrowed USDC as preservation tolerates; smaller is safer |
| Aave HF | Above 1.8 always; above 2.0 before entering/reranging |
| Regime (sign-aware) | Up-trend: keep earning. Range: full size. Down-trend −0.5→−1.0: defend. < −1.0: reduce/exit |
| Range shape | Wide + downside-skewed by default; tight-centered only in confirmed low-vol range |
| Hold duration | Position should plausibly hold >7 days with weekly-only management |
| Range location | Middle third healthy; upper third = fee-continuity only; lower third = defend |
| Inventory mix | Avoid becoming mostly WHYPE near the lower bound; keep a healthy USDC share |
| Structural hedge | Run Mode A at 50–75% of current WHYPE delta; rebalance only at range thirds; never exceed 100% (naked) |
| Funding | Positive funding supports the standing hedge; shrink hedge if carry turns persistently negative |
| Fee income vs DL | Wide ranges trade fee density for fewer reranges and lower management — the intended trade |

---

## Decision Template

Use this sequence whenever reviewing the active position:

1. Confirm Aave HF is safely above the hard floor (and >2.0 before any new deployment).
2. Recalculate 30-day **signed** drift/vol. Up-trend or range → operate normally;
   down-trend → defend or stand aside.
3. Confirm position size is within preservation tolerance.
4. Locate current price inside the LP range (third).
5. Check current WHYPE/USDC inventory mix and USDC repayment coverage.
6. Apply the action:
   - Upper third → mechanical rerange-up only if needed to keep fees on; no inventory urgency.
   - Middle third → hold.
   - Lower third / down-trend → widen, reduce, extend hedge, close, or repay — never tight-recenter.
7. Set the structural hedge (Mode A) to 50–75% of current WHYPE delta; rebalance only when
   price crosses a third; trim toward zero as the LP becomes mostly USDC. Use a Mode B
   tactical hedge only as a bridge to exit, with stop set first and max loss ≤ 7 days of fees.

Do not put position-specific token IDs, ranges, prices, or balances in this playbook. Store
live state in the tracker and regenerate it during each review.
