import type { DashboardPosition } from "./api";
import { useDashboardPositions } from "./queries";

export function App() {
  const { data: positions, error, isLoading, isFetching } = useDashboardPositions();

  return (
    <main className="min-h-screen bg-white text-neutral-950">
      <section className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <header className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
          <div className="border-b border-neutral-200 px-5 py-3 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3 text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-neutral-500">
              <span>HyperEVM ProjectX</span>
              <span className="flex items-center gap-2 text-neutral-700">
                <span className="h-2 w-2 rounded-full bg-neutral-950" />
                {isFetching && !isLoading ? "Reconciling On-Chain Data" : "Live Execution View"}
              </span>
            </div>
          </div>
          <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[1fr_420px] lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.35em] text-neutral-500">
                Concentrated Liquidity Command Center
              </p>
              <h1 className="mt-3 max-w-4xl text-4xl font-black tracking-[-0.04em] text-neutral-950 sm:text-6xl lg:text-7xl">
                Portfolio Risk & Range Operations
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-neutral-600 sm:text-base">
                Institutional monitoring for concentrated liquidity desks: live range status,
                fee capture, token exposure, and mark-to-market P&L from the Fastify API.
              </p>
            </div>
            <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.26em] text-neutral-500">
                Operating Mode
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <HeaderStat label="Latency" value="API" />
                <HeaderStat label="Source" value="RPC" />
                <HeaderStat label="Desk" value="LP" />
              </div>
            </div>
          </div>
        </header>

        {isLoading ? <LoadingState /> : null}
        {error ? <ErrorState error={error} /> : null}
        {!isLoading && !error && positions ? (
          <Dashboard positions={positions} />
        ) : null}
      </section>
    </main>
  );
}

export function Dashboard({ positions }: { positions: DashboardPosition[] }) {
  if (positions.length === 0) {
    return <EmptyState />;
  }

  const openPositions = positions.filter((position) => position.status !== "closed");
  const totals = positions.reduce(
    (acc, position) => {
      acc.active += position.status === "active" ? 1 : 0;
      acc.inRange += position.inRange ? 1 : 0;
      acc.pnl += position.pnl?.absolutePnlInToken1 ?? 0;
      acc.fees += position.pnl?.feesValueInToken1 ?? 0;
      if (typeof position.pnl?.feesValueUsd === "number") {
        acc.feesUsd += position.pnl.feesValueUsd;
        acc.feesUsdCount += 1;
      }
      return acc;
    },
    { active: 0, inRange: 0, pnl: 0, fees: 0, feesUsd: 0, feesUsdCount: 0 }
  );

  const token1Symbol = positions.find((p) => p.pnl)?.pnl?.token1Symbol ?? "token1";
  const activePercent = positions.length ? totals.active / positions.length : 0;
  const inRangePercent = positions.length ? totals.inRange / positions.length : 0;

  return (
    <>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Book Positions" value={positions.length.toString()} detail="Tracked NFTs" />
        <MetricCard label="Active Capital" value={totals.active.toString()} detail={formatPercent(activePercent)} />
        <MetricCard label="Range Compliance" value={`${totals.inRange}/${positions.length}`} detail={formatPercent(inRangePercent)} />
        <MetricCard
          label="Fee Income USD"
          value={totals.feesUsdCount > 0 ? formatUsd(totals.feesUsd) : "USD unavailable"}
          detail={`Net P&L ${formatNumber(totals.pnl)} ${token1Symbol}`}
          tone={totals.feesUsdCount > 0 ? totals.feesUsd : undefined}
        />
      </section>

      {openPositions.length > 0 ? <ActivePositions positions={openPositions} /> : null}

      <section className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-5 py-4">
          <div>
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.28em] text-neutral-500">Blotter</p>
            <h2 className="mt-1 text-lg font-bold text-neutral-950">Position Detail Ledger</h2>
          </div>
          <span className="rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1 text-xs font-semibold text-neutral-600">
            {positions.length} instruments
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-neutral-200 text-sm">
            <thead className="bg-neutral-50 text-left text-[0.68rem] uppercase tracking-[0.18em] text-neutral-500">
              <tr>
                <th className="px-5 py-3">Pair</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Price</th>
                <th className="px-5 py-3">Range</th>
                <th className="px-5 py-3">P&L</th>
                <th className="px-5 py-3">Fees</th>
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

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
      <p className="text-[0.62rem] uppercase tracking-[0.18em] text-neutral-500">{label}</p>
      <p className="mt-1 font-mono text-sm font-bold text-neutral-950">{value}</p>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: number;
}) {
  return (
    <div className="group rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-neutral-500">{label}</p>
        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-neutral-300 transition group-hover:bg-neutral-950" />
      </div>
      <p className={`mt-4 font-mono text-3xl font-black tracking-tight ${toneClass(tone)}`}>{value}</p>
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

  return (
    <article className="grid gap-5 px-5 py-5 text-neutral-950 sm:px-7 lg:grid-cols-[1.25fr_1fr_1fr_0.9fr_1.55fr] lg:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <TokenPairIcon token0={position.token0.symbol} token1={position.token1.symbol} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-black tracking-[-0.03em] text-neutral-950">
              {position.token0.symbol}/{position.token1.symbol}
            </h2>
            <span className="rounded bg-neutral-300 px-2 py-0.5 font-mono text-[0.68rem] font-bold text-neutral-600">
              Wallet #1
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-neutral-600">
            <span className={`h-2.5 w-2.5 rounded-full ${venue.dotClass}`} />
            <span>{venue.name}</span>
            <span className="text-neutral-400">♦</span>
            <span>{position.feePercent}%</span>
          </p>
        </div>
      </div>

      <DarkStat label="Balance" value={balance == null ? "USD unavailable" : formatUsd(balance)} />
      <DarkStat
        label="Pending Earnings"
        value={formatUsdFeeValue(pnl?.feesValueUsd)}
        detail={pnl ? `Fees ${formatNumber(pnl.feesValueInToken1)} ${pnl.token1Symbol}` : undefined}
      />
      <DarkStat
        label="APR"
        value={pnl ? formatPercent(pnl.absolutePnlPercent) : "n/a"}
        valueClassName={pnl ? darkToneClass(pnl.absolutePnlPercent) : undefined}
      />

      <div className="min-w-0 font-mono text-xs font-bold">
        <div className="mb-1 flex justify-between gap-3 text-neutral-600">
          <span>{formatPrice(position.priceLower)}</span>
          <span>{formatPrice(position.priceUpper)}</span>
        </div>
        <div className="relative h-1.5 rounded-full bg-neutral-400/70">
          <div className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${rangeTone}`} style={{ width: `${marker}%` }} />
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-neutral-700 shadow-[0_0_0_2px_rgba(0,0,0,0.08)]"
            style={{ left: `${marker}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between gap-3">
          <span className={position.inRange ? "text-rose-600" : "text-neutral-500"}>{formatSignedPercent(leftDistance)}</span>
          <span className={position.inRange ? "text-emerald-700" : "text-rose-600"}>{formatSignedPercent(rightDistance)}</span>
        </div>
      </div>
    </article>
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
    <span className={`absolute top-0 grid h-8 w-8 place-items-center rounded-full border-2 border-neutral-200 bg-gradient-to-br ${palette} text-[0.62rem] font-black text-white shadow-lg ${className}`}>
      {symbol.slice(0, 1)}
    </span>
  );
}

function DarkStat({
  label,
  value,
  detail,
  valueClassName = "text-neutral-950",
}: {
  label: string;
  value: string;
  detail?: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <p className="text-xs font-bold text-neutral-600">{label}</p>
      <p className={`mt-2 font-mono text-base font-black ${valueClassName}`}>{value}</p>
      {detail ? <p className="mt-1 text-[0.68rem] font-semibold text-neutral-500">{detail}</p> : null}
    </div>
  );
}

function PositionRow({ position }: { position: DashboardPosition }) {
  const pnl = position.pnl;

  return (
    <tr className="text-neutral-700 transition hover:bg-neutral-50">
      <td className="whitespace-nowrap px-5 py-4 font-semibold text-neutral-950">
        {position.token0.symbol}/{position.token1.symbol}
        <span className="ml-2 font-mono text-xs text-neutral-500">#{position.tokenId}</span>
      </td>
      <td className="whitespace-nowrap px-5 py-4">
        <div className="flex gap-2">
          <StatusBadge status={position.status} />
          <RangeBadge inRange={position.inRange} />
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-4 font-mono">{formatPrice(position.currentPrice)}</td>
      <td className="whitespace-nowrap px-5 py-4 font-mono text-neutral-600">
        {formatPrice(position.priceLower)} - {formatPrice(position.priceUpper)}
      </td>
      <td className={`whitespace-nowrap px-5 py-4 font-mono font-bold ${toneClass(pnl?.absolutePnlInToken1)}`}>
        {pnl ? `${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}` : "n/a"}
      </td>
      <td className="whitespace-nowrap px-5 py-4 font-mono text-neutral-600">
        {pnl ? (
          <div>
            <p className={`font-bold ${toneClass(usdFeeValue(pnl.feesValueUsd))}`}>{formatUsdFeeValue(pnl.feesValueUsd)}</p>
            <p className="mt-1 text-xs text-neutral-500">
              {formatNumber(pnl.feesValueInToken1)} {pnl.token1Symbol}
            </p>
          </div>
        ) : (
          "n/a"
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: DashboardPosition["status"] }) {
  const className =
    status === "active"
      ? "border-neutral-950 bg-neutral-950 text-white"
      : "border-neutral-300 bg-neutral-100 text-neutral-600";

  return <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${className}`}>{status}</span>;
}

function RangeBadge({ inRange }: { inRange: boolean }) {
  const className = inRange
    ? "border-neutral-950 bg-white text-neutral-950"
    : "border-neutral-300 bg-neutral-100 text-neutral-600";

  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${className}`}>
      {inRange ? "in range" : "out of range"}
    </span>
  );
}

function DataPoint({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: number;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
      <p className={`mt-2 break-words font-mono text-sm font-semibold ${toneClass(tone)}`}>{value}</p>
      {detail ? <p className="mt-1 text-xs font-medium text-neutral-500">{detail}</p> : null}
    </div>
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

function formatNumber(value: number): string {
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

function formatUsd(value: number): string {
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

function darkToneClass(value?: number): string {
  if (value == null || value === 0) return "text-neutral-950";
  return value > 0 ? "text-emerald-700" : "text-rose-600";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
