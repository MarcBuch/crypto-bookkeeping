---
name: news-sentiment-fetcher
description: Use when the user wants to know why a token pumped or dumped, wants recent news or catalysts for a token, asks about upcoming token unlocks, or wants sentiment context before making an LP decision. Fetches CoinGecko news, token unlock schedules, and recent on-chain events.
---

# Skill: News & Sentiment Fetcher

Fetches recent news, token unlock schedules, and market catalysts for any token to provide context for LP and trading decisions.

## When to use

- User asks "why did X pump/dump?"
- User wants to know if a price move has fundamental backing
- User asks about upcoming token unlocks or vesting events
- User wants sentiment context before reranging or closing a position
- User asks "is this trend durable?"

## How to Run

```bash
SKILL_DIR=$(git rev-parse --show-toplevel)/.opencode/skills/news-sentiment-fetcher

# Human-readable output
bun "$SKILL_DIR/fetch-news.ts" hyperliquid

# Structured JSON (for programmatic use)
bun "$SKILL_DIR/fetch-news.ts" hyperliquid --json 2>/dev/null
```

The script fetches in parallel:
- **CoinGecko free API** — market data, sentiment votes, ATH, price changes
- **CoinGecko trending** — whether the token is trending and its rank
- **CoinGecko coin page** — news headlines, "why moving" summary, upcoming unlock

Common coin IDs: `hyperliquid`, `bitcoin`, `ethereum`, `solana`.

## JSON Output Schema

```json
{
  "coin": "hyperliquid",
  "symbol": "HYPE",
  "name": "Hyperliquid",
  "fetchedAt": "2026-06-04T17:45:00.000Z",
  "market": {
    "price": 66.49,
    "change24h": -9.85,
    "change7d": 9.49,
    "change14d": 13.65,
    "change30d": 50.01,
    "ath": 75.48,
    "athDate": "2026-06-02",
    "athChangePct": -11.91,
    "volume24h": 1886252893,
    "marketCap": 14807921396,
    "circulatingSupply": 222445714,
    "totalSupply": 955307079
  },
  "sentiment": {
    "bullishPct": 55.2,
    "bearishPct": 44.8,
    "isTrending": true,
    "trendingRank": 2
  },
  "topCatalyst": "Hyperliquid Drops 6.5% as Arthur Hayes Sells Entire HYPE Stake",
  "recentlyHappened": [
    { "headline": "Arthur Hayes Sells Entire Hyperliquid (HYPE) Position", "age": "about 5 hours ago" }
  ],
  "latestNews": [
    { "headline": "Hyperliquid pulls back from record highs as Arthur Hayes exits position", "age": "about 4 hours ago" }
  ],
  "upcomingUnlock": {
    "dateStr": "June 6",
    "daysAway": 2,
    "amountRaw": "$659.48M",
    "recipient": "Core Contributors"
  }
}
```

## Workflow

### Step 1: Run the script

```bash
bun "$SKILL_DIR/fetch-news.ts" <coin_id> --json 2>/dev/null
```

Parse the JSON output. If the script fails (rate limit, network), fall back to fetching the CoinGecko coin page manually:

```
https://www.coingecko.com/en/coins/{coin_id}
```

Extract from the page:
- **"Why X is moving"** section — CoinGecko's AI summary of recent catalysts
- **"Recently Happened"** section — timestamped news events
- **Latest News** articles
- **Upcoming unlock** — date, amount, % of supply, USD value
- **7d / 30d price performance** vs market

### Step 2: Assess catalyst quality

Classify each catalyst:

| Type | Durability | LP implication |
|------|-----------|----------------|
| Protocol buybacks (ongoing) | High | Trend may persist |
| New product launch / market expansion | Medium-High | Depends on adoption |
| Short squeeze / liquidation cascade | Low | Likely to reverse |
| Whale accumulation | Medium | Reduces float, bullish short-term |
| Token unlock upcoming | Negative near-term | Potential sell pressure |
| Macro / BTC correlation | Low (for ratio pairs) | May not affect token0/token1 ratio |
| Exchange listing | Medium | One-time demand spike |
| Hack / exploit / bad news | Negative | Consider closing LP |

### Step 3: Check token unlock schedule

Look for the **"Upcoming Unlock"** section on CoinGecko. Key fields:
- Date of next unlock
- Amount unlocking (tokens and USD value)
- % of total supply
- Recipient (team, investors, community)

**Risk assessment:**
- Unlock > 1% of supply within 14 days → meaningful sell pressure risk
- Team/investor unlocks → higher sell pressure than community unlocks
- Unlock value > 10% of 30d average daily volume → significant

### Step 4: Assess trend durability

Combine the catalyst quality with the price data:

**Durable trend signals:**
- Fundamental catalyst (buybacks, revenue growth, new product)
- Consistent drift across 7d AND 14d AND 30d (not just recent spike)
- High and growing trading volume
- Whale accumulation reducing float

**Fragile trend signals:**
- Short squeeze as primary driver
- Single news event without follow-through
- Drift only in last 7d, flat or negative over 30d
- Upcoming large unlock

### Step 5: Synthesize for LP decision

Output a structured assessment:

**Catalyst summary**: What drove the move and how durable it is.

**Upcoming risks**: Token unlocks, known events, macro factors.

**LP implication**:
- If trend is durable + strong → HODL likely outperforms LP; consider closing
- If trend is fragile + likely to reverse → LP range centered at current price is reasonable; reversal would reduce DL
- If range-bound / no clear trend → LP is well-suited; optimize range width for fees

## Example output format

```
## Catalyst Analysis: HYPE

### Why it moved
- $1.16B in protocol buybacks (ongoing, structural)
- Record 7% share of global perpetual futures OI
- New markets launched (SPACX futures, RWA expansion)
- Short squeeze: $13M shorts liquidated in 24h (partially mechanical)

### Catalyst durability: MEDIUM-HIGH
Buybacks and platform growth are structural. Short squeeze component is temporary.

### Upcoming risks
- June 6 token unlock: 9.92M HYPE (~$618M, 1% of supply) for Core Contributors
  → Meaningful near-term headwind, 12 days away

### LP implication
Strong trend with fundamental backing → LP underperforms HODL in this environment.
The June 6 unlock creates a known near-term reversal risk.
Recommendation: symmetric range to handle both upside continuation and unlock-driven pullback.
```

## Important notes

- CoinGecko pages are JavaScript-heavy; the WebFetch tool may return partial content. Focus on extracting the text sections (news headlines, "why moving", unlock data) rather than charts.
- Token unlock data is also available at tokenomist.ai and token.unlocks.app if CoinGecko doesn't show it clearly.
- Always distinguish between HYPE/USD catalysts and HYPE/BTC ratio catalysts. For a WHYPE/UBTC LP, only the ratio matters — a BTC pump that outpaces HYPE is a negative for the position even if HYPE/USD is up.
- News is backward-looking. Treat it as context for assessing durability, not as a prediction.
