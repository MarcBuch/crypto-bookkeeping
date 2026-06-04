#!/usr/bin/env bun
/**
 * fetch-news.ts — News, sentiment and catalyst fetcher via CoinGecko.
 *
 * Uses:
 *   - CoinGecko public API (free) for market data + sentiment
 *   - CoinGecko coin page for news headlines, "why moving", upcoming unlock
 *
 * Usage:
 *   bun .opencode/skills/news-sentiment-fetcher/fetch-news.ts [coin_id] [--json]
 *
 * Examples:
 *   bun fetch-news.ts hyperliquid
 *   bun fetch-news.ts bitcoin --json
 */

const coinId =
  process.argv.find(
    (a) =>
      !a.startsWith("--") &&
      !a.includes("fetch-news") &&
      !a.includes("bun") &&
      !a.endsWith(".ts"),
  ) ?? "hyperliquid";

const jsonMode = process.argv.includes("--json");

const COINGECKO_API = "https://api.coingecko.com/api/v3";
const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface MarketData {
  price: number;
  change24h: number;
  change7d: number;
  change14d: number;
  change30d: number;
  ath: number;
  athDate: string;
  athChangePct: number;
  volume24h: number;
  marketCap: number;
  circulatingSupply: number;
  totalSupply: number;
}

interface SentimentData {
  bullishPct: number;
  bearishPct: number;
  isTrending: boolean;
  trendingRank: number | null;
}

interface NewsItem {
  headline: string;
  age: string;
  isTopCatalyst?: boolean;
}

interface UnlockData {
  dateStr: string;
  daysAway: number | null;
  amountRaw: string;
  recipient: string | null;
}

interface NewsReport {
  coin: string;
  symbol: string;
  name: string;
  fetchedAt: string;
  market: MarketData;
  sentiment: SentimentData;
  topCatalyst: string | null;
  recentlyHappened: NewsItem[];
  latestNews: NewsItem[];
  upcomingUnlock: UnlockData | null;
}

// ─── API Fetchers ─────────────────────────────────────────────────────────────

async function fetchCoinApi(id: string): Promise<Record<string, unknown>> {
  const url = `${COINGECKO_API}/coins/${id}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

async function fetchTrending(): Promise<unknown[]> {
  const res = await fetch(`${COINGECKO_API}/search/trending`);
  if (!res.ok) return [];
  const d = (await res.json()) as { coins?: unknown[] };
  return d.coins ?? [];
}

async function fetchCoinPage(id: string): Promise<string> {
  const url = `https://www.coingecko.com/en/coins/${id}`;
  const res = await fetch(url, { headers: PAGE_HEADERS });
  if (!res.ok) throw new Error(`Page fetch error: ${res.status}`);
  return res.text();
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseMarketData(d: Record<string, unknown>): MarketData {
  const md = (d.market_data ?? {}) as Record<string, unknown>;
  const usd = (o: unknown) => (o as Record<string, number> | null)?.usd ?? 0;
  return {
    price: usd(md.current_price),
    change24h: (md.price_change_percentage_24h as number) ?? 0,
    change7d: (md.price_change_percentage_7d as number) ?? 0,
    change14d: (md.price_change_percentage_14d as number) ?? 0,
    change30d: (md.price_change_percentage_30d as number) ?? 0,
    ath: usd(md.ath),
    athDate:
      ((md.ath_date as Record<string, string> | null)?.usd ?? "").split(
        "T",
      )[0] ?? "",
    athChangePct:
      (md.ath_change_percentage as Record<string, number> | null)?.usd ?? 0,
    volume24h: usd(md.total_volume),
    marketCap: usd(md.market_cap),
    circulatingSupply: (md.circulating_supply as number) ?? 0,
    totalSupply: (md.total_supply as number) ?? 0,
  };
}

function parseSentiment(
  d: Record<string, unknown>,
  trending: unknown[],
  id: string,
): SentimentData {
  const trendingItem = (
    trending as { item?: { id?: string } }[]
  ).find((c) => c.item?.id === id);
  const trendingRank = trendingItem
    ? (trending as unknown[]).indexOf(trendingItem) + 1
    : null;
  return {
    bullishPct: (d.sentiment_votes_up_percentage as number) ?? 0,
    bearishPct: (d.sentiment_votes_down_percentage as number) ?? 0,
    isTrending: trendingItem != null,
    trendingRank,
  };
}

function isHeadline(s: string): boolean {
  return (
    s.length >= 20 &&
    s.length <= 250 &&
    !/^\d+(\.\d+)?(%)?$/.test(s) &&
    !s.startsWith("http") &&
    !s.startsWith("<") &&
    !s.startsWith("{") &&
    /[A-Z]/.test(s) &&
    !/^(Today|Yesterday|This week)$/.test(s)
  );
}

function extractNews(text: string): {
  topCatalyst: string | null;
  recentlyHappened: NewsItem[];
  latestNews: NewsItem[];
  unlock: UnlockData | null;
} {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const recentlyHappened: NewsItem[] = [];
  const latestNews: NewsItem[] = [];
  let topCatalyst: string | null = null;
  let unlock: UnlockData | null = null;
  const seen = new Set<string>();

  // ── Top catalyst: alt attribute of first img near "Why X is moving" ──────
  // CoinGecko embeds the headline as alt text on the catalyst article image.
  const whyMovingIdx = lines.findIndex((l) => /why\s+\w+\s+is\s+moving/i.test(l));
  if (whyMovingIdx >= 0) {
    // Search forward for the first alt="..." that looks like a headline
    for (let i = whyMovingIdx; i < Math.min(whyMovingIdx + 80, lines.length); i++) {
      const altMatch = lines[i].match(/alt="([^"]{20,200})"/);
      if (altMatch && isHeadline(altMatch[1])) {
        topCatalyst = altMatch[1];
        break;
      }
    }
  }

  // ── Recently Happened: timestamp-first structure ──────────────────────────
  // Pattern: "about N hours" (no "ago") → within next 15 lines → headline text
  const recentlyHappenedIdx = lines.findIndex((l) =>
    /recently\s+happened/i.test(l),
  );
  const latestNewsIdx = lines.findIndex((l) =>
    /latest\s+news/i.test(l),
  );

  if (recentlyHappenedIdx >= 0) {
    const endIdx =
      latestNewsIdx > recentlyHappenedIdx ? latestNewsIdx : lines.length;

    for (
      let i = recentlyHappenedIdx;
      i < endIdx - 1 && recentlyHappened.length < 8;
      i++
    ) {
      // Timestamp line: "about N hours" or "about N days" (without trailing "ago")
      if (!/^about\s+\d+\s+(second|minute|hour|day|week|month)s?$/i.test(lines[i]))
        continue;
      const age = lines[i];

      // Search forward up to 15 lines for the headline
      for (let j = i + 1; j < Math.min(i + 15, endIdx); j++) {
        if (isHeadline(lines[j]) && !seen.has(lines[j])) {
          seen.add(lines[j]);
          recentlyHappened.push({ headline: lines[j], age });
          break;
        }
      }
    }
  }

  // ── Latest News: headline-first structure ─────────────────────────────────
  // Pattern: alt="Headline" in img tag, then within next 20 lines "about N hours ago"
  if (latestNewsIdx >= 0) {
    for (
      let i = latestNewsIdx;
      i < lines.length - 1 && latestNews.length < 6;
      i++
    ) {
      const altMatch = lines[i].match(/alt="([^"]{20,200})"/);
      if (!altMatch || !isHeadline(altMatch[1])) continue;
      const headline = altMatch[1];
      if (seen.has(headline)) continue;

      // Search forward for the "about N hours ago" timestamp
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        if (
          /^about\s+\d+\s+(second|minute|hour|day|week|month)s?\s+ago$/i.test(
            lines[j],
          )
        ) {
          seen.add(headline);
          latestNews.push({
            headline,
            age: lines[j],
            isTopCatalyst: headline === topCatalyst,
          });
          break;
        }
      }
    }
  }

  // ── Upcoming unlock ───────────────────────────────────────────────────────
  const unlockIdx = lines.findIndex(
    (l) =>
      /upcoming\s+unlock/i.test(l) ||
      (/token\s+unlock/i.test(l) && l.length < 40),
  );
  if (unlockIdx >= 0) {
    const ctx = lines.slice(unlockIdx, unlockIdx + 30).join(" ");

    const dateMatch = ctx.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?/i,
    );
    const daysAwayMatch =
      ctx.match(/(\d+)\s+days?\s+away/i) ||
      ctx.match(/in\s+(\d+)\s+days?/i);
    const amountMatch =
      ctx.match(/\$[\d.,]+[KMBT]?/i) ||
      ctx.match(/[\d.,]+[KMB]?\s+\w{2,8}\s*\(?\$[\d.,]+[KMBT]?\)?/i);
    const recipientMatch = ctx.match(
      /for\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]*){0,3})/,
    );

    if (dateMatch) {
      unlock = {
        dateStr: dateMatch[0],
        daysAway: daysAwayMatch ? parseInt(daysAwayMatch[1]) : null,
        amountRaw: amountMatch ? amountMatch[0] : "unknown",
        recipient: recipientMatch ? recipientMatch[1] : null,
      };
    }
  }

  return { topCatalyst, recentlyHappened, latestNews, unlock };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function catalystDurability(
  topCatalyst: string | null,
  change24h: number,
): string {
  if (!topCatalyst) return "UNKNOWN";
  const c = topCatalyst.toLowerCase();
  if (/hack|exploit|rug|scam|security|breach/.test(c))
    return "HIGH NEGATIVE — security event, consider closing";
  if (/arthur hayes|whale|sell|dump|exit|insider/.test(c))
    return "MEDIUM — whale-driven, may partially reverse";
  if (/unlock|vesting|cliff/.test(c))
    return "HIGH NEGATIVE — structural sell pressure";
  if (/buyback|revenue|protocol|fundamental/.test(c))
    return "HIGH POSITIVE — structural, durable";
  if (/squeeze|liquidat/.test(c))
    return "LOW — mechanical, likely temporary";
  if (/etf|institution|grayscale|blackrock/.test(c))
    return "MEDIUM-HIGH — institutional demand";
  if (/listing|integration|partnership/.test(c))
    return "MEDIUM — one-time demand spike";
  if (Math.abs(change24h) > 10)
    return "UNKNOWN — sharp move without clear durable catalyst";
  return "LOW — unclear catalyst";
}

function lpImplication(
  change24h: number,
  change7d: number,
  unlock: UnlockData | null,
): string[] {
  const lines: string[] = [];

  if (unlock?.daysAway != null && unlock.daysAway <= 7) {
    lines.push(
      `⚠️  Unlock in ${unlock.daysAway}d (${unlock.amountRaw}${unlock.recipient ? ` → ${unlock.recipient}` : ""}) — near-term sell pressure`,
    );
  }

  if (change24h < -8) {
    lines.push(
      "Sharp 24h drop — reranging now crystallises DL at the low; wait for stabilisation or set hard stop at lower bound",
    );
  } else if (change24h < -3) {
    lines.push(
      "Mild pullback — monitor lower bound; rerange if position drifts into outer third",
    );
  } else if (change24h > 8) {
    lines.push(
      "Sharp 24h pump — LP is selling your position into strength; HODL outperforms LP in this environment",
    );
  }

  if (Math.abs(change7d) > 15) {
    lines.push(
      `Strong 7d trend (${fmtPct(change7d)}) — LP underperforms HODL; evaluate regime (drift/vol ratio)`,
    );
  }

  if (lines.length === 0) {
    lines.push(
      "Range-bound conditions — LP well-suited; optimise range width for fee yield",
    );
  }

  return lines;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [coinData, trendingData, pageText] = await Promise.all([
    fetchCoinApi(coinId),
    fetchTrending(),
    fetchCoinPage(coinId).catch(() => ""),
  ]);

  const market = parseMarketData(coinData);
  const sentiment = parseSentiment(coinData, trendingData, coinId);
  const { topCatalyst, recentlyHappened, latestNews, unlock } =
    extractNews(pageText);

  const report: NewsReport = {
    coin: coinId,
    symbol: (coinData.symbol as string)?.toUpperCase() ?? coinId.toUpperCase(),
    name: (coinData.name as string) ?? coinId,
    fetchedAt: new Date().toISOString(),
    market,
    sentiment,
    topCatalyst,
    recentlyHappened,
    latestNews,
    upcomingUnlock: unlock,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Human-readable output ────────────────────────────────────────────────
  const { symbol, name } = report;
  console.log(`\n## News & Sentiment: ${name} (${symbol})`);
  console.log(`Fetched: ${new Date(report.fetchedAt).toUTCString()}\n`);

  console.log("### Market Context");
  console.log(
    `  Price:      $${fmt(market.price)} (24h: ${fmtPct(market.change24h)})`,
  );
  console.log(
    `  7d / 30d:   ${fmtPct(market.change7d)} / ${fmtPct(market.change30d)}`,
  );
  console.log(
    `  ATH:        $${fmt(market.ath)} on ${market.athDate}  (${fmtPct(market.athChangePct)} from ATH)`,
  );
  console.log(`  Volume 24h: ${fmtUsd(market.volume24h)}`);
  console.log(`  Market Cap: ${fmtUsd(market.marketCap)}`);

  console.log("\n### Sentiment");
  const trendStr = sentiment.isTrending
    ? `  |  Trending #${sentiment.trendingRank} on CoinGecko`
    : "";
  console.log(
    `  ${fmt(sentiment.bullishPct, 0)}% bullish / ${fmt(sentiment.bearishPct, 0)}% bearish${trendStr}`,
  );

  if (topCatalyst) {
    console.log("\n### Top Catalyst (Why it moved)");
    console.log(`  "${topCatalyst}"`);
    console.log(
      `  Durability: ${catalystDurability(topCatalyst, market.change24h)}`,
    );
  }

  if (recentlyHappened.length > 0) {
    console.log("\n### Recently Happened");
    recentlyHappened
      .slice(0, 6)
      .forEach((n) => console.log(`  • ${n.headline}  (${n.age})`));
  }

  if (latestNews.length > 0) {
    console.log("\n### Latest News");
    latestNews
      .slice(0, 4)
      .forEach((n) => console.log(`  • ${n.headline}  (${n.age})`));
  }

  if (unlock) {
    console.log("\n### Upcoming Token Unlock");
    console.log(
      `  Date:      ${unlock.dateStr}${unlock.daysAway != null ? `  (${unlock.daysAway} day${unlock.daysAway === 1 ? "" : "s"} away)` : ""}`,
    );
    console.log(`  Amount:    ${unlock.amountRaw}`);
    if (unlock.recipient) console.log(`  Recipient: ${unlock.recipient}`);
    if (unlock.daysAway != null && unlock.daysAway <= 7) {
      console.log(`  ⚠️  NEAR-TERM RISK — unlock within 1 week`);
    }
  }

  console.log("\n### LP Implication");
  lpImplication(market.change24h, market.change7d, unlock).forEach((l) =>
    console.log(`  ${l}`),
  );

  console.log();
}

main().catch((err: Error) => {
  console.error("Error:", err.message);
  process.exit(1);
});
