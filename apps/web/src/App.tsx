import { useRef, useState } from "react";

import type { DashboardPosition } from "./api";
import { buildNetHedgePnL } from "./hedge-pnl";
import {
  useDashboardPositions,
  useSyncPositions,
  useSyncPosition,
} from "./hooks/useDashboardPositions";
import { useHedge } from "./hooks/useHedge";

export function App() {
  const { data, error, isLoading, isFetching } = useDashboardPositions();
  const {
    trigger: syncPositions,
    isPolling: isSyncing,
    syncStatus,
    error: syncError,
  } = useSyncPositions();
  const positions = data?.positions;
  const syncedAt = data?.syncedAt ?? null;

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <header className="rounded-3xl border border-neutral-200 bg-white px-5 py-3 shadow-sm sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 text-[0.68rem] font-semibold tracking-[0.22em] text-neutral-500 uppercase">
            <span>HyperEVM ProjectX</span>
            <span className="flex flex-wrap items-center gap-3 text-neutral-700">
              <a className="transition hover:text-neutral-950" href="/tax">
                Tax Ledger
              </a>
              <span className="h-3 w-px bg-neutral-300" />
              <button
                onClick={() => syncPositions()}
                disabled={isSyncing}
                className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-[0.68rem] font-semibold tracking-[0.18em] text-neutral-700 uppercase transition hover:border-neutral-950 hover:text-neutral-950 disabled:opacity-50"
              >
                {isSyncing ? "Syncing…" : "Sync"}
              </button>
              <span className="h-3 w-px bg-neutral-300" />
              <span className="h-2 w-2 rounded-full bg-neutral-950" />
              {isFetching && !isLoading ? "Reconciling On-Chain Data" : "Live Execution View"}
            </span>
          </div>
        </header>

        {isLoading ? <LoadingState /> : null}
        {error ? <ErrorState error={error} /> : null}
        {isSyncing ? (
          <div className="rounded-3xl border border-neutral-200 bg-white px-5 py-3 shadow-sm">
            <div className="flex items-center gap-3 text-sm font-medium text-neutral-700">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-neutral-950" />
              Sync in progress…
            </div>
          </div>
        ) : null}
        {!isSyncing && syncStatus?.status === "completed" ? (
          <div className="rounded-3xl border border-neutral-200 bg-white px-5 py-3 text-sm font-medium text-neutral-600 shadow-sm">
            Sync complete
          </div>
        ) : null}
        {syncError ? (
          <div className="rounded-3xl border border-rose-200 bg-rose-50 px-5 py-3 text-sm font-medium text-rose-700">
            Sync failed: {errorMessage(syncError)}
          </div>
        ) : null}
        {!isLoading && !error && syncedAt !== undefined ? (
          <p className="text-xs font-semibold text-neutral-400">
            Last synced: {syncedAt ? new Date(syncedAt).toLocaleString() : "Never synced"}
          </p>
        ) : null}
        {!isLoading && !error && positions ? <Dashboard positions={positions} /> : null}
      </section>
    </main>
  );
}

function PnlHeaderTooltip() {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  function handleMouseEnter() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCoords({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setVisible(true);
  }

  return (
    <span
      ref={ref}
      className="inline-flex cursor-help items-center gap-1"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setVisible(false)}
    >
      P&L
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-neutral-200 text-[0.6rem] leading-none font-bold text-neutral-500 select-none">
        ?
      </span>
      {visible && (
        <span
          className="pointer-events-none fixed z-[9999] w-64 rounded-lg bg-neutral-900 px-3 py-2 text-xs font-normal tracking-normal text-white normal-case shadow-lg"
          style={{ left: coords.x, top: coords.y - 8, transform: "translate(-50%, -100%)" }}
        >
          Actual gain or loss vs your initial deposit, in the quote token. Positive = made money.
          Does not include what you would have earned by simply holding (see Divergence Loss for
          that).
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </span>
  );
}

function FeesHeaderTooltip() {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  function handleMouseEnter() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCoords({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setVisible(true);
  }

  return (
    <span
      ref={ref}
      className="inline-flex cursor-help items-center gap-1"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setVisible(false)}
    >
      Total Fees
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-neutral-200 text-[0.6rem] leading-none font-bold text-neutral-500 select-none">
        ?
      </span>
      {visible && (
        <span
          className="pointer-events-none fixed z-[9999] w-64 rounded-lg bg-neutral-900 px-3 py-2 text-xs font-normal tracking-normal text-white normal-case shadow-lg"
          style={{ left: coords.x, top: coords.y - 8, transform: "translate(-50%, -100%)" }}
        >
          All fees earned over the life of this position — both already collected and currently
          pending. Included in the ROI calculation.
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </span>
  );
}

export function Dashboard({ positions }: { positions: DashboardPosition[] }) {
  if (positions.length === 0) {
    return <EmptyState />;
  }

  const openPositions = positions.filter((position) => position.status !== "closed");
  const totals = positions.reduce(
    (acc, position) => {
      acc.pnl += position.pnl?.absolutePnlInToken1 ?? 0;
      acc.fees += position.pnl?.feesValueInToken1 ?? 0;
      if (typeof position.pnl?.feesValueUsd === "number") {
        acc.feesUsd += position.pnl.feesValueUsd;
        acc.feesUsdCount += 1;
      }
      return acc;
    },
    { pnl: 0, fees: 0, feesUsd: 0, feesUsdCount: 0 },
  );

  const token1Symbol = positions.find((p) => p.pnl)?.pnl?.token1Symbol ?? "token1";

  return (
    <>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Book Positions"
          value={positions.length.toString()}
          detail="Tracked NFTs"
        />
        <MetricCard
          label="Total MTM P&L"
          value={`${formatNumber(totals.pnl)} ${token1Symbol}`}
          detail="Mark-to-market"
          valueClassName={pnlToneClass(totals.pnl)}
        />
        <MetricCard
          label="Carry Run Rate"
          value={totals.feesUsdCount > 0 ? formatUsd(totals.feesUsd) : "USD unavailable"}
          detail="30-day normalized"
          tone={totals.feesUsdCount > 0 ? totals.feesUsd : undefined}
        />
        <MetricCard
          label="Fee Income USD"
          value={totals.feesUsdCount > 0 ? formatUsd(totals.feesUsd) : "USD unavailable"}
          detail={`${formatNumber(totals.fees)} ${token1Symbol}`}
          tone={totals.feesUsdCount > 0 ? totals.feesUsd : undefined}
        />
      </section>

      {openPositions.length > 0 ? <ActivePositions positions={openPositions} /> : null}

      <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <p className="text-[0.65rem] font-semibold tracking-[0.28em] text-neutral-500 uppercase">
              Blotter
            </p>
            <h2 className="mt-1 text-lg font-bold text-neutral-950">Position Detail Ledger</h2>
          </div>
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-600">
            {positions.length} instruments
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-left text-[0.68rem] tracking-[0.18em] text-neutral-500 uppercase">
              <tr>
                <th className="px-5 py-3">Pair</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Price</th>
                <th className="px-5 py-3">Range</th>
                <th className="px-5 py-3">
                  <PnlHeaderTooltip />
                </th>
                <th className="px-5 py-3">
                  <FeesHeaderTooltip />
                </th>
                <th className="px-5 py-3" aria-label="Actions"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200">
              {positions.map((position) => (
                <PositionRow key={position.tokenId} position={position} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
  valueClassName,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: number;
  valueClassName?: string;
}) {
  return (
    <div className="group rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.68rem] font-semibold tracking-[0.22em] text-neutral-500 uppercase">
          {label}
        </p>
        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-neutral-300 transition group-hover:bg-neutral-950" />
      </div>
      <p
        className={`mt-4 font-mono text-3xl font-black tracking-tight ${valueClassName ?? toneClass(tone)}`}
      >
        {value}
      </p>
      {detail ? <p className="mt-2 text-xs font-medium text-neutral-500">{detail}</p> : null}
    </div>
  );
}

function ActivePositions({ positions }: { positions: DashboardPosition[] }) {
  return (
    <section className="overflow-hidden rounded-[1.75rem] border border-neutral-300 bg-neutral-200 shadow-sm">
      <div className="divide-y divide-neutral-300">
        {positions.map((position) => (
          <ActivePositionRow key={position.tokenId} position={position} />
        ))}
      </div>
    </section>
  );
}

function ActivePositionRow({ position }: { position: DashboardPosition }) {
  const pnl = position.pnl;
  const balance = currentBalanceUsd(position);
  const venue = venueLabel(position);
  const marker = rangeFill(position);
  const leftDistance = (position.currentPrice - position.priceLower) / position.currentPrice;
  const rightDistance = (position.priceUpper - position.currentPrice) / position.currentPrice;
  const rangeTone = position.inRange ? "from-emerald-500 to-teal-300" : "from-rose-400 to-red-500";
  const { trigger: syncPosition, isPolling: isSyncingPosition } = useSyncPosition(position.tokenId);
  const { data: hedgeData } = useHedge(position.tokenId);

  // Hedge-adjusted ROI — computed via shared helper (same logic as CLI pnl-format.ts)
  const {
    lpPnlUsd: lpAbsPnlUsd,
    hedgePnlUsd,
    lpEntryUsd,
    combinedPnlUsd: combinedAbsUsd,
    combinedRoiPct,
  } = hedgeData
    ? buildNetHedgePnL(pnl, hedgeData)
    : {
        lpPnlUsd: null,
        hedgePnlUsd: null,
        lpEntryUsd: null,
        combinedPnlUsd: null,
        combinedRoiPct: null,
      };

  const roiDetail = pnl
    ? (() => {
        const netUsd = combinedAbsUsd ?? lpAbsPnlUsd;
        const netToken = `${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}`;
        const display = netUsd != null ? formatUsd(netUsd) : netToken;
        const tone = darkToneClass(netUsd != null ? netUsd : pnl.absolutePnlInToken1);
        return <span className={tone}>{display}</span>;
      })()
    : undefined;

  return (
    <div>
      <article className="grid gap-5 px-5 py-5 text-neutral-950 sm:px-7 lg:grid-cols-[1.25fr_1fr_1fr_0.9fr_1.55fr_auto] lg:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <TokenPairIcon token0={position.token0.symbol} token1={position.token1.symbol} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-black tracking-[-0.03em] text-neutral-950">
                {position.token0.symbol}/{position.token1.symbol}
              </h2>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-neutral-600">
              <span className={`h-2.5 w-2.5 rounded-full ${venue.dotClass}`} />
              <span>{venue.name}</span>
              <span className="text-neutral-400">♦</span>
              <span>{position.feePercent}%</span>
            </p>
          </div>
        </div>

        <DarkStat
          label="Balance"
          value={balance == null ? "USD unavailable" : formatUsd(balance)}
        />
        <DarkStat
          label="Pending Earnings"
          value={pnl ? `${formatNumber(pnl.pendingFeesValueInToken1)} ${pnl.token1Symbol}` : "n/a"}
          detail={
            pnl?.pendingFeesValueUsd != null
              ? formatUsdFeeValue(pnl.pendingFeesValueUsd)
              : undefined
          }
        />
        <DarkStat
          label="ROI"
          value={pnl ? formatPercent(combinedRoiPct ?? pnl.absolutePnlPercent) : "n/a"}
          valueClassName={pnl ? darkToneClass(combinedRoiPct ?? pnl.absolutePnlPercent) : undefined}
          detail={roiDetail}
          tooltip={
            pnl
              ? (() => {
                  const lines: string[] = [];
                  if (combinedRoiPct != null) {
                    lines.push(`Net (LP + hedge): ${formatUsd(combinedAbsUsd!)}`);
                    lines.push(`  LP P&L:      ${formatUsd(lpAbsPnlUsd!)}`);
                    lines.push(`  Hedge P&L:   ${formatUsd(hedgePnlUsd!)}`);
                    lines.push(`Entry value:   ${formatUsd(lpEntryUsd!)}`);
                  } else if (lpAbsPnlUsd != null) {
                    lines.push(`LP P&L: ${formatUsd(lpAbsPnlUsd)}`);
                    lines.push(
                      `  Fees: ${formatUsd(pnl.feesValueUsd ?? pnl.feesValueInToken1)} ${pnl.feesValueUsd == null ? pnl.token1Symbol : ""}`,
                    );
                    lines.push(`Entry: ${formatUsd(lpEntryUsd!)}`);
                  } else {
                    lines.push(
                      `LP P&L: ${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}`,
                    );
                    lines.push(
                      `  Fees: ${formatNumber(pnl.feesValueInToken1)} ${pnl.token1Symbol}`,
                    );
                    lines.push(
                      `Entry: ${formatNumber(pnl.entryValueInToken1)} ${pnl.token1Symbol}`,
                    );
                  }
                  lines.push(`ROI = net P&L ÷ entry value`);
                  return lines.join("\n");
                })()
              : undefined
          }
        />

        <div className="min-w-0 font-mono text-xs font-bold">
          <div className="mb-1 flex justify-between gap-3 text-neutral-600">
            <span>{formatPrice(position.priceLower)}</span>
            <span>{formatPrice(position.priceUpper)}</span>
          </div>
          <div className="relative h-1.5 rounded-full bg-neutral-400/70">
            {/* Left outer-third rerange zone */}
            <div className="absolute inset-y-0 left-0 w-1/3 rounded-l-full bg-amber-400/20" />
            {/* Right outer-third rerange zone */}
            <div className="absolute inset-y-0 right-0 w-1/3 rounded-r-full bg-amber-400/20" />
            {/* Gradient fill */}
            <div
              className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${rangeTone}`}
              style={{ width: `${marker}%` }}
            />
            {/* Third-boundary dividers */}
            <div className="absolute inset-y-0 z-10 w-px bg-white/70" style={{ left: "33.33%" }} />
            <div className="absolute inset-y-0 z-10 w-px bg-white/70" style={{ left: "66.67%" }} />
            {/* Current price marker dot */}
            <span
              className="absolute top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-700 shadow-[0_0_0_2px_rgba(0,0,0,0.08)]"
              style={{ left: `${marker}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between gap-3">
            <span className={position.inRange ? "text-rose-600" : "text-neutral-500"}>
              {formatSignedPercent(leftDistance)}
            </span>
            <span className={position.inRange ? "text-emerald-700" : "text-rose-600"}>
              {formatSignedPercent(rightDistance)}
            </span>
          </div>
        </div>

        <div className="flex items-center lg:justify-end">
          <button
            onClick={() => void syncPosition()}
            disabled={isSyncingPosition}
            className="rounded-full border border-neutral-300 bg-white/80 px-3 py-1 text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-600 uppercase transition hover:border-neutral-950 hover:text-neutral-950 disabled:opacity-40"
          >
            {isSyncingPosition ? "Syncing…" : "Sync"}
          </button>
        </div>
      </article>

      {hedgeData && <HedgePanel hedge={hedgeData} pnl={position.pnl ?? undefined} />}
    </div>
  );
}

function HedgePanel({
  hedge,
  pnl,
}: {
  hedge: import("./api").HedgeView;
  pnl?: import("./api").PnLView;
}) {
  const [expanded, setExpanded] = useState(false);

  const size = Math.abs(parseFloat(hedge.szi));
  const unrealizedTone = hedge.unrealizedPnl >= 0 ? "text-emerald-700" : "text-rose-600";
  // Mark price color tracks direction of the trade: green when short is winning (price ↓), red when losing (price ↑)
  const markTone = hedge.unrealizedPnl >= 0 ? "text-emerald-700" : "text-rose-600";

  // Use shared helper — same logic as CLI pnl-format.ts and core buildNetHedgePnL
  const {
    lpPnlUsd: lpAbsPnl,
    hedgePnlUsd: hedgePnl,
    combinedPnlUsd: combinedPnl,
  } = buildNetHedgePnL(pnl, hedge);
  const combinedTone =
    combinedPnl == null
      ? "text-neutral-950"
      : combinedPnl >= 0
        ? "text-emerald-700"
        : "text-rose-600";

  return (
    <div className="bg-neutral-300">
      {/* Always-visible summary row — click to expand/collapse */}
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center justify-between gap-3 px-5 py-2 text-left transition hover:bg-black/[0.04] sm:px-7"
      >
        {/* Left — identity */}
        <div className="flex min-w-0 items-center gap-2">
          {hedge.status === "closed" ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-400 bg-neutral-200 px-2 py-0.5 text-[0.6rem] font-black tracking-[0.18em] text-neutral-700 uppercase">
              ■ CLOSED
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rose-400 bg-rose-100 px-2 py-0.5 text-[0.6rem] font-black tracking-[0.18em] text-rose-700 uppercase">
              ▼ SHORT
            </span>
          )}
          <span className="truncate font-mono text-xs font-bold tracking-tight text-neutral-950">
            {size} {hedge.coin}-PERP
          </span>
          <span className="hidden truncate text-[0.65rem] font-medium text-neutral-400 sm:inline">
            {hedge.status === "closed" && hedge.closeReason
              ? hedge.closeReason
              : hedge.leverage.value > 0
                ? `${hedge.leverage.value}× ${hedge.leverage.type}`
                : hedge.leverage.type}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {/* Net hedged P&L — single line */}
          {combinedPnl != null && (
            <span className="font-mono text-xs font-bold">
              <span className="mr-1 font-medium text-neutral-400">net</span>
              <span className={combinedTone}>{formatUsd(combinedPnl)}</span>
              <span className="ml-1 hidden font-normal text-neutral-400 sm:inline">
                (LP {formatUsd(lpAbsPnl!)} · hedge {formatUsd(hedgePnl)})
              </span>
            </span>
          )}

          {/* Chevron */}
          <span
            className={`shrink-0 text-neutral-500 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
            aria-hidden
          >
            ▾
          </span>
        </div>
      </button>

      {/* Expandable detail section */}
      {expanded && (
        <div className="border-t border-neutral-400/40 px-5 pt-4 pb-5 sm:px-7">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {hedge.status === "closed" ? (
              <>
                <HedgeStat label="Entry" value={`$${formatPrice(hedge.entryPx)}`} />
                <HedgeStat label="Close" value={`$${formatPrice(hedge.markPx)}`} />
                <HedgeStat
                  label="Realized P&L"
                  value={hedge.realizedPnl != null ? formatUsd(hedge.realizedPnl) : "unknown"}
                  valueClassName={
                    hedge.realizedPnl == null
                      ? "text-neutral-400"
                      : hedge.realizedPnl >= 0
                        ? "text-emerald-700"
                        : "text-rose-600"
                  }
                />
                <HedgeStat
                  label="Funding earned"
                  value={`+${formatUsd(hedge.fundingEarned)}`}
                  valueClassName="text-emerald-700"
                />
                {hedgePnl != null && (
                  <HedgeStat
                    label="Hedge P&L"
                    value={formatUsd(hedgePnl)}
                    valueClassName={hedgePnl >= 0 ? "text-emerald-700" : "text-rose-600"}
                    detail="realized + funding"
                  />
                )}
              </>
            ) : (
              <>
                <HedgeStat label="Entry" value={`$${formatPrice(hedge.entryPx)}`} />
                <HedgeStat
                  label="Mark"
                  value={`$${formatPrice(hedge.markPx)}`}
                  valueClassName={markTone}
                />
                <HedgeStat
                  label="Unrealized"
                  value={formatUsd(hedge.unrealizedPnl)}
                  valueClassName={unrealizedTone}
                />
                <HedgeStat
                  label="Funding earned"
                  value={`+${formatUsd(hedge.fundingEarned)}`}
                  valueClassName="text-emerald-700"
                />
                <HedgeStat
                  label="Liquidation"
                  value={hedge.liquidationPx ? `$${formatPrice(hedge.liquidationPx)}` : "—"}
                  valueClassName="text-amber-700"
                />
                <HedgeStat
                  label="Hedge P&L"
                  value={formatUsd(hedgePnl)}
                  valueClassName={hedgePnl >= 0 ? "text-emerald-700" : "text-rose-600"}
                  detail="unrealized + funding"
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function HedgeStat({
  label,
  value,
  valueClassName = "text-neutral-950",
  detail,
}: {
  label: string;
  value: string;
  valueClassName?: string;
  detail?: string;
}) {
  return (
    <div>
      <p className="text-[0.62rem] font-semibold tracking-[0.15em] text-neutral-500 uppercase">
        {label}
      </p>
      <p className={`mt-1 font-mono text-sm font-black ${valueClassName}`}>{value}</p>
      {detail && <p className="mt-0.5 text-[0.6rem] text-neutral-600">{detail}</p>}
    </div>
  );
}

function TokenPairIcon({ token0, token1 }: { token0: string; token1: string }) {
  return (
    <div className="relative h-9 w-12 shrink-0">
      <TokenIcon symbol={token0} className="left-0 z-10" />
      <TokenIcon symbol={token1} className="left-5" />
    </div>
  );
}

function TokenIcon({ symbol, className }: { symbol: string; className: string }) {
  const palette = tokenPalette(symbol);

  return (
    <span
      className={`absolute top-0 grid h-8 w-8 place-items-center rounded-full border-2 border-neutral-200 bg-gradient-to-br ${palette} text-[0.62rem] font-black text-white shadow-lg ${className}`}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}

export function DarkStat({
  label,
  value,
  detail,
  valueClassName = "text-neutral-950",
  tooltip,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  valueClassName?: string;
  tooltip?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLParagraphElement>(null);

  function handleMouseEnter() {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCoords({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setVisible(true);
  }

  return (
    <div>
      <p className="text-xs font-bold text-neutral-600">{label}</p>
      <p
        ref={ref}
        className={`mt-2 font-mono text-base font-black ${tooltip ? "cursor-default" : ""} ${valueClassName}`}
        onMouseEnter={tooltip ? handleMouseEnter : undefined}
        onMouseLeave={tooltip ? () => setVisible(false) : undefined}
      >
        {value}
      </p>
      {detail ? (
        <p className="mt-1 text-[0.68rem] font-semibold text-neutral-500">{detail}</p>
      ) : null}
      {tooltip && visible && (
        <span
          className="pointer-events-none fixed z-[9999] w-48 rounded-lg bg-neutral-900 px-3 py-2 text-xs font-normal tracking-normal whitespace-pre-line text-white normal-case shadow-lg"
          style={{ left: coords.x, top: coords.y - 8, transform: "translate(-50%, -100%)" }}
        >
          {tooltip}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-neutral-900" />
        </span>
      )}
    </div>
  );
}

function PositionRow({ position }: { position: DashboardPosition }) {
  const pnl = position.pnl;
  const {
    trigger: syncPosition,
    isPolling: isSyncingPosition,
    error: syncPositionError,
  } = useSyncPosition(position.tokenId);

  return (
    <tr className="text-neutral-700 transition hover:bg-neutral-50">
      <td className="px-5 py-4 font-semibold whitespace-nowrap text-neutral-950">
        {position.token0.symbol}/{position.token1.symbol}
        <span className="ml-2 font-mono text-xs text-neutral-500">#{position.tokenId}</span>
      </td>
      <td className="px-5 py-4 whitespace-nowrap">
        <div className="flex gap-2">
          <StatusBadge status={position.status} />
          <RangeBadge inRange={position.inRange} />
        </div>
      </td>
      <td className="px-5 py-4 font-mono whitespace-nowrap">
        {formatPrice(position.currentPrice)}
      </td>
      <td className="px-5 py-4 font-mono whitespace-nowrap text-neutral-600">
        {formatPrice(position.priceLower)} - {formatPrice(position.priceUpper)}
      </td>
      <td
        className={`px-5 py-4 font-mono font-bold whitespace-nowrap ${toneClass(pnl?.absolutePnlInToken1)}`}
      >
        {pnl ? `${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}` : "n/a"}
        {pnl && pnl.token1UsdPrice != null && (
          <div className="mt-0.5 text-xs font-normal text-neutral-400">
            {formatUsd(pnl.absolutePnlInToken1 * pnl.token1UsdPrice)}
          </div>
        )}
      </td>
      <td className="px-5 py-4 font-mono whitespace-nowrap text-neutral-600">
        {pnl ? (
          <div>
            <p className={`font-bold ${toneClass(usdFeeValue(pnl.feesValueUsd))}`}>
              {formatUsdFeeValue(pnl.feesValueUsd)}
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              {formatNumber(pnl.feesValueInToken1)} {pnl.token1Symbol}
            </p>
          </div>
        ) : (
          "n/a"
        )}
      </td>
      <td className="px-5 py-4 whitespace-nowrap">
        <button
          onClick={() => void syncPosition()}
          disabled={isSyncingPosition}
          className="rounded-full border border-neutral-300 bg-white px-2.5 py-0.5 text-[0.65rem] font-semibold tracking-[0.14em] text-neutral-600 uppercase transition hover:border-neutral-950 hover:text-neutral-950 disabled:opacity-40"
        >
          {isSyncingPosition ? "…" : "Sync"}
        </button>
        {syncPositionError ? <span className="ml-2 text-xs text-rose-600">!</span> : null}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: DashboardPosition["status"] }) {
  const className =
    status === "active"
      ? "border-neutral-950 bg-neutral-950 text-white"
      : "border-neutral-300 bg-neutral-100 text-neutral-600";

  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-bold tracking-wide uppercase ${className}`}
    >
      {status}
    </span>
  );
}

function RangeBadge({ inRange }: { inRange: boolean }) {
  const className = inRange
    ? "border-neutral-950 bg-white text-neutral-950"
    : "border-neutral-300 bg-neutral-100 text-neutral-600";

  return (
    <span
      className={`rounded-full border px-3 py-1 text-xs font-bold tracking-wide uppercase ${className}`}
    >
      {inRange ? "in range" : "out of range"}
    </span>
  );
}

export function LoadingState() {
  return (
    <div className="rounded-3xl border border-neutral-200 bg-white p-8 text-neutral-600 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-neutral-950" />
        Loading LP positions...
      </div>
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="rounded-3xl border border-neutral-300 bg-neutral-50 p-8 shadow-sm">
      <h2 className="text-xl font-bold text-neutral-950">Could not load LP positions</h2>
      <p className="mt-2 text-neutral-600">{errorMessage(error)}</p>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="rounded-3xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-2xl font-black text-neutral-950">No LP positions found</h2>
      <p className="mt-2 text-neutral-500">
        Add positions to your wallet/config and refresh the API data.
      </p>
    </div>
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Math.abs(value) < 1 ? 6 : 2,
  }).format(value);
}

function usdFeeValue(value: number | null | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function formatUsdFeeValue(value: number | null | undefined): string {
  return typeof value === "number" ? formatUsd(value) : "USD unavailable";
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) < 1 && value !== 0 ? 6 : 2,
  }).format(value);
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 6,
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    signDisplay: "always",
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}

function currentBalanceUsd(position: DashboardPosition): number | null {
  const token0Usd = position.pnl?.token0UsdPrice;
  const token1Usd = position.pnl?.token1UsdPrice;

  if (typeof token0Usd !== "number" || typeof token1Usd !== "number") {
    return null;
  }

  return position.currentAmount0 * token0Usd + position.currentAmount1 * token1Usd;
}

function venueLabel(position: DashboardPosition): { name: string; dotClass: string } {
  if (position.feePercent <= 0.05) {
    return { name: "Uniswap v3", dotClass: "bg-fuchsia-500" };
  }

  return { name: "ProjectX", dotClass: "bg-teal-400" };
}

function tokenPalette(symbol: string): string {
  if (/usdc/i.test(symbol)) return "from-sky-300 to-blue-600";
  if (/btc/i.test(symbol)) return "from-orange-200 to-orange-500";
  if (/eth|hype/i.test(symbol)) return "from-zinc-100 to-slate-500";
  return "from-emerald-200 to-teal-600";
}

function rangeFill(position: DashboardPosition): number {
  const span = position.priceUpper - position.priceLower;
  if (span <= 0) return 0;
  const progress = ((position.currentPrice - position.priceLower) / span) * 100;
  return Math.min(100, Math.max(0, progress));
}

function toneClass(value?: number): string {
  if (value == null || value === 0) return "text-neutral-950";
  return value > 0 ? "text-neutral-950" : "text-neutral-500";
}

function pnlToneClass(value: number): string {
  if (value === 0) return "text-neutral-950";
  return value > 0 ? "text-emerald-700" : "text-rose-600";
}

function darkToneClass(value?: number): string {
  if (value == null || value === 0) return "text-neutral-950";
  return value > 0 ? "text-emerald-700" : "text-rose-600";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
