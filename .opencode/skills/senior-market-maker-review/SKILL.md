---
name: senior-market-maker-review
description: Use when the user asks for a senior market maker review, position review, daily LP review, or wants to create a dated trade_log for the active WHYPE/USDC LP position. Runs live LP, regime, news, trend, and hedge checks, then writes trade_log/<utc timestamp>/position-review.md.
---

# Senior Market Maker Review

Creates a dated trade log review for the active ProjectX WHYPE/USDC LP position using the current playbook, prior trade logs, and live market/position data.

Use this skill when the user asks to:

- “run a senior market maker review”
- “review the active position”
- “write today’s trade log”
- “create a position review”
- “update the verdict”
- “compare today against the last trade log”

## Output

Write a new Markdown file:

```bash
trade_log/<YYYY-MM-DD_HH-MM-SS>/position-review.md
```

Use UTC for the directory timestamp. The final answer to the user should include the path and the top-line verdict.

## Required Inputs

Read these first:

1. `PLAYBOOK.md`
2. All existing `trade_log/*/*.md` files, especially the most recent one
3. `config.json` to identify the active position token ID

Important current strategy rules from the playbook:

- This book is capital-preservation-first, fee-income-second.
- Preservation means USDC available to repay the borrow, not HYPE upside and not a high-water mark on appreciated USDC.
- Uptrends are benign-to-good because the LP sells WHYPE into USDC.
- Downtrends are the real threat because the LP buys WHYPE with borrowed USDC.
- Use signed drift/vol. Exit/defend on confirmed negative drift, especially `< -1.0` for 7+ days.
- Upper third means fee-continuity only; no inventory urgency.
- Lower third means defend: widen, reduce, hedge, close, or repay. Never tight-recenter into weakness.
- Structural hedge Mode A is 50-75% of current LP WHYPE delta, never >100% delta.
- Mostly USDC near the upper bound means no hedge / trim toward zero.

## Commands To Run

Run from the repo root unless noted. Use JSON where possible.

### 1. Resolve Active Position

```bash
REPO=$(git rev-parse --show-toplevel)
bun run "$REPO/apps/cli/src/index.ts" --json positions 2>/dev/null
bun run "$REPO/apps/cli/src/index.ts" --json pnl 2>/dev/null
```

Pick the active WHYPE/USDC position. In the current setup this is usually token `484645`, but do not hardcode it if live output says otherwise.

Extract:

- token ID, pair, status, in-range
- entry/current price
- lower/upper range
- current token amounts and inventory mix
- fees collected and pending
- absolute P&L
- divergence loss / opportunity cost
- net-vs-HODL
- hedge block, if present

### 2. News / Sentiment

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/news-sentiment-fetcher
bun "$SKILL_DIR/fetch-news.ts" hyperliquid --json 2>/dev/null
```

Extract:

- price, 24h/7d/14d/30d changes
- ATH drawdown
- volume, market cap if useful
- sentiment and trending rank
- recent catalysts
- upcoming unlock, if any

### 3. Regime

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/regime-checker
bun "$SKILL_DIR/check-regime.ts" HYPE --json 2>/dev/null
```

Extract:

- 30d dailyDrift, dailyVol, ratio, regime
- 7d ratio and regime
- open interest
- whether windows diverge

Convert the regime into the playbook’s sign-aware interpretation:

- positive ratio > +0.5: rising; keep earning unless other risks dominate
- -0.5 to +0.5: range-bound; full position, wide range
- -1.0 to -0.5: soft downtrend; reduce/widen/skew/hedge
- < -1.0: dangerous downtrend; reduce hard or stand aside, especially if persistent

If the script reports only absolute ratio, use dailyDrift sign to recover signed ratio.

### 4. Delta Hedge Advisor

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/delta-hedge-advisor
bun "$SKILL_DIR/hedge-advisor.ts" <TOKEN_ID> --json 2>/dev/null
```

Extract:

- current WHYPE exposure and notional
- exposure at lower/upper bound
- funding rate and daily carry
- fee-optimization verdict
- capital-preservation verdict
- suggested hedge size if forced
- stop scenarios
- downside/upside scenarios

Apply playbook override when needed:

- If LP is mostly USDC near upper bound, do not hedge even if capital-preservation flag fires mechanically.
- If price is middle/lower-third and LP has meaningful WHYPE delta, Mode A structural hedge can be appropriate.
- If lower-third/downtrend, hedge is a bridge to reduce/close/repay, not permission to stay wrong.

### 5. 24h / 48h Market Price Data

```bash
bun -e 'const end=Date.now(); const start=end-48*60*60*1000; const res=await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"candleSnapshot",req:{coin:"HYPE",interval:"1h",startTime:start,endTime:end}})}); if(!res.ok) throw new Error(`${res.status} ${await res.text()}`); const candles=await res.json(); const rows=candles.map(c=>({t:new Date(c.T||c.t).toISOString(),o:+c.o,h:+c.h,l:+c.l,c:+c.c,v:+c.v})); const latest=rows.at(-1); const c24=rows.find(x=>new Date(x.t).getTime()>=end-24*60*60*1000) ?? rows[rows.length-25]; const first=rows[0]; const minmax=(arr)=>arr.reduce((a,x)=>({high:Math.max(a.high,x.h),low:Math.min(a.low,x.l),volume:a.volume+x.v}),{high:-Infinity,low:Infinity,volume:0}); const last24=rows.filter(x=>new Date(x.t).getTime()>=end-24*60*60*1000); console.log(JSON.stringify({coin:"HYPE",source:"Hyperliquid candleSnapshot 1h",fetchedAt:new Date(end).toISOString(),points:rows.length,latest,change24hPct:(latest.c/c24.c-1)*100,change48hPct:(latest.c/first.c-1)*100,last24:minmax(last24),last48:minmax(rows)},null,2));'
```

Extract:

- latest close
- 24h and 48h return
- 24h and 48h high/low
- volume if useful

### 6. Trend-vs-LP Cross-Check

Use the `trend-vs-lp` skill logic with live P&L and daily candles. If no dedicated script exists, compute manually:

```bash
bun -e 'const res=await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"candleSnapshot",req:{coin:"HYPE",interval:"1d",startTime:Date.now()-33*24*60*60*1000,endTime:Date.now()}})}); if(!res.ok) throw new Error(`${res.status} ${await res.text()}`); const candles=await res.json(); const closes=candles.map(c=>({t:new Date(c.T||c.t).toISOString(),c:+c.c})); const returns=[]; for(let i=1;i<closes.length;i++) returns.push(Math.log(closes[i].c/closes[i-1].c)); const mean=returns.reduce((a,b)=>a+b,0)/returns.length; const vol=Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1)); const pct=(n)=>((closes.at(-1).c/closes.at(-1-n).c-1)*100); console.log(JSON.stringify({source:"Hyperliquid candleSnapshot 1d",points:closes.length,returns:returns.length,current:closes.at(-1),dailyDrift:mean,dailyVol:vol,signedRatio:mean/vol,absRatio:Math.abs(mean)/vol,change7dPct:pct(7),change14dPct:pct(14),change30dPct:pct(30)},null,2));'
```

Interpret:

- Is LP currently beating HODL net of fees?
- Are fees covering divergence loss?
- Is current drift harmful under this playbook? Positive drift is not harmful for this book; negative persistent drift is.
- Is reranging likely to improve fee capture enough to justify inventory reset/churn?

### 7. Optional Pool Economics

If the decision depends on fee opportunity or boost expiry, use `projectx-pool-stats` as supporting context. Do not block the review if this fails.

## Trade Log Writing Rules

Before writing, create the directory:

```bash
TS=$(date -u +%Y-%m-%d_%H-%M-%S)
mkdir "trade_log/$TS"
```

Write `trade_log/$TS/position-review.md` with `apply_patch` or another approved edit tool. Keep the review decision-oriented. Do not dump raw JSON.

## Recommended Document Structure

```markdown
# Position Review — WHYPE/USDC #<TOKEN_ID>
*Generated: YYYY-MM-DD HH:MM UTC*

## Inputs And Skills Used

- `PLAYBOOK.md` — ...
- `trade_log/...` — prior verdict baseline
- `lp-tracker` — ...
- `news-sentiment-fetcher` — ...
- `regime-checker` — ...
- `delta-hedge-advisor` — ...
- `trend-vs-lp` — ...
- Hyperliquid `candleSnapshot` — ...

> Senior market-maker summary paragraph with the verdict.

---

## 1. What Changed Since Last Review

Compare last log vs today: price, range location, inventory, P&L, fees, divergence loss, net-vs-HODL, regime, hedge status.

---

## 2. Playbook Checks

### Mandate
### Regime
### Range Location
### Inventory Mix

---

## 3. P&L And Fee Engine

Show absolute P&L, fees, pending fees, divergence loss, net-vs-HODL, fee run-rate, and whether fees cover DL.

---

## 4. Market Context

### Last 24h / 48h
### News / Sentiment

---

## 5. Hedge Review

Show advisor verdicts, current delta, funding, ladder status, and whether playbook overrides the mechanical hedge flag.

---

## Verdict — <HOLD / RERANGE / HEDGE / REDUCE / CLOSE>

State exact action. Include execution rules and trigger levels.
```

## Verdict Framework

Use market-maker judgment, not mechanical tool output.

### Hold

Use when:

- LP is in range
- no negative regime trigger
- fees cover or are likely to cover divergence loss
- range location does not demand action
- hedge is not needed or not yet armed

### Rerange Up

Use when:

- price breaks or is about to break upper bound
- position would otherwise earn zero fees
- inventory is mostly USDC, so reranging is fee-continuity, not defense

Prefer wide / low-touch range. Avoid tight recentering unless confirmed low-vol range-bound.

### Hedge / Arm Mode A

Use when:

- price has moved into middle/lower area where LP has meaningful WHYPE delta
- range-bound or soft-down regime makes structural hedge useful
- funding is acceptable
- hedge size is 50-75% of live WHYPE delta and never >100%

If using an existing ladder from prior log, report which rung is armed/not armed.

### Reduce / Close

Use when:

- signed drift/vol is confirmed negative and dangerous
- price is lower-third and inventory is becoming mostly WHYPE
- Aave HF is below hard floor or borrow repayment floor is threatened
- position is out of range and reopening would force bad inventory

### No Hedge Override

Even if capital-preservation verdict says `hedge-recommended`, do not hedge when:

- LP is mostly USDC near upper bound
- current WHYPE delta is tiny
- short would become naked on a small rally
- funding is negative and inventory risk is not yet active

## Common Gotchas

- Do not use absolute drift/vol only. This playbook is sign-aware.
- Do not treat HYPE upside opportunity cost as a failure; this book does not optimize for HYPE upside.
- Do not count USDC-to-WHYPE conversion as a loss by itself. The real cost is divergence loss and debt-floor risk.
- Do not front-run a hedge ladder before the LP actually re-accumulates WHYPE.
- Do not repeat the Jun 11 failure mode: oversized short with a stop inside normal vol.
- If a prior trade log conflicts with the current `PLAYBOOK.md`, follow the current playbook and document the reconciliation.

## Final Response To User

After writing the file, respond briefly:

```markdown
Created today’s senior market-maker review:

`trade_log/<timestamp>/position-review.md`

Verdict: **...**
```

Remind the user to restart opencode only if this skill file itself was created or edited during the session, because skill discovery is config-time.
