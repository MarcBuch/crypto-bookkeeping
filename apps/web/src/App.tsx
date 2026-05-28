import type { DashboardPosition } from "./api";
import { useDashboardPositions } from "./queries";

export function App() {
  const { data: positions, error, isLoading, isFetching } = useDashboardPositions();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="rounded-[2rem] border border-cyan-300/20 bg-slate-900/80 p-6 shadow-2xl shadow-cyan-950/30 sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.35em] text-cyan-300">
            HyperEVM ProjectX
          </p>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight text-white sm:text-6xl">
                LP Tracker
              </h1>
              <p className="mt-3 max-w-2xl text-base text-slate-300 sm:text-lg">
                Monitor concentrated liquidity positions, range status, fees,
                and P&L from the Fastify API.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-slate-300">
              {isFetching && !isLoading ? "Refreshing on-chain data..." : "Live API view"}
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

  const totals = positions.reduce(
    (acc, position) => {
      acc.active += position.status === "active" ? 1 : 0;
      acc.inRange += position.inRange ? 1 : 0;
      acc.pnl += position.pnl?.absolutePnlInToken1 ?? 0;
      acc.fees += position.pnl?.feesValueInToken1 ?? 0;
      return acc;
    },
    { active: 0, inRange: 0, pnl: 0, fees: 0 }
  );

  const token1Symbol = positions.find((p) => p.pnl)?.pnl?.token1Symbol ?? "token1";

  return (
    <>
      <section className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Positions" value={positions.length.toString()} />
        <MetricCard label="Active" value={totals.active.toString()} />
        <MetricCard label="In range" value={`${totals.inRange}/${positions.length}`} />
        <MetricCard
          label={`Net P&L (${token1Symbol})`}
          value={formatNumber(totals.pnl)}
          tone={totals.pnl}
        />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        {positions.map((position) => (
          <PositionCard key={position.tokenId} position={position} />
        ))}
      </section>

      <section className="overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/70">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="text-lg font-bold text-white">Position Details</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-950/60 text-left text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-3">Pair</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Price</th>
                <th className="px-5 py-3">Range</th>
                <th className="px-5 py-3">P&L</th>
                <th className="px-5 py-3">Fees</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
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
  tone,
}: {
  label: string;
  value: string;
  tone?: number;
}) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`mt-2 text-3xl font-black ${toneClass(tone)}`}>{value}</p>
    </div>
  );
}

function PositionCard({ position }: { position: DashboardPosition }) {
  const pnl = position.pnl;

  return (
    <article className="rounded-3xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-slate-950/30">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-400">#{position.tokenId}</p>
          <h2 className="text-2xl font-black text-white">
            {position.token0.symbol}/{position.token1.symbol}
          </h2>
        </div>
        <div className="flex gap-2">
          <StatusBadge status={position.status} />
          <RangeBadge inRange={position.inRange} />
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <DataPoint label="Current price" value={formatPrice(position.currentPrice)} />
        <DataPoint
          label="Range"
          value={`${formatPrice(position.priceLower)} - ${formatPrice(position.priceUpper)}`}
        />
        <DataPoint
          label="Current amounts"
          value={`${formatNumber(position.currentAmount0)} ${position.token0.symbol} / ${formatNumber(position.currentAmount1)} ${position.token1.symbol}`}
        />
        <DataPoint label="Fee tier" value={`${position.feePercent}%`} />
      </div>

      <div className="mt-5 rounded-2xl bg-slate-950/70 p-4">
        {pnl ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <DataPoint
              label="Absolute P&L"
              value={`${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}`}
              tone={pnl.absolutePnlInToken1}
            />
            <DataPoint
              label="P&L %"
              value={formatPercent(pnl.absolutePnlPercent)}
              tone={pnl.absolutePnlPercent}
            />
            <DataPoint
              label="Net vs HODL"
              value={formatPercent(pnl.netVsHodlPercent)}
              tone={pnl.netVsHodlPercent}
            />
          </div>
        ) : (
          <p className="text-sm text-amber-200">P&L data unavailable for this position.</p>
        )}
      </div>
    </article>
  );
}

function PositionRow({ position }: { position: DashboardPosition }) {
  const pnl = position.pnl;

  return (
    <tr className="text-slate-200">
      <td className="whitespace-nowrap px-5 py-4 font-semibold">
        {position.token0.symbol}/{position.token1.symbol}
        <span className="ml-2 text-slate-500">#{position.tokenId}</span>
      </td>
      <td className="whitespace-nowrap px-5 py-4">
        <div className="flex gap-2">
          <StatusBadge status={position.status} />
          <RangeBadge inRange={position.inRange} />
        </div>
      </td>
      <td className="whitespace-nowrap px-5 py-4">{formatPrice(position.currentPrice)}</td>
      <td className="whitespace-nowrap px-5 py-4">
        {formatPrice(position.priceLower)} - {formatPrice(position.priceUpper)}
      </td>
      <td className={`whitespace-nowrap px-5 py-4 font-bold ${toneClass(pnl?.absolutePnlInToken1)}`}>
        {pnl ? `${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}` : "n/a"}
      </td>
      <td className="whitespace-nowrap px-5 py-4">
        {pnl ? `${formatNumber(pnl.feesValueInToken1)} ${pnl.token1Symbol}` : "n/a"}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: DashboardPosition["status"] }) {
  const className =
    status === "active"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
      : "border-slate-500/40 bg-slate-500/10 text-slate-300";

  return <span className={`rounded-full border px-3 py-1 text-xs font-bold ${className}`}>{status}</span>;
}

function RangeBadge({ inRange }: { inRange: boolean }) {
  const className = inRange
    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-200"
    : "border-amber-400/40 bg-amber-400/10 text-amber-200";

  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-bold ${className}`}>
      {inRange ? "in range" : "out of range"}
    </span>
  );
}

function DataPoint({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: number;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 break-words font-semibold ${toneClass(tone)}`}>{value}</p>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-slate-300">
      Loading LP positions...
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="rounded-3xl border border-red-400/30 bg-red-950/40 p-8">
      <h2 className="text-xl font-bold text-red-100">Could not load LP positions</h2>
      <p className="mt-2 text-red-200">{errorMessage(error)}</p>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center">
      <h2 className="text-2xl font-black text-white">No LP positions found</h2>
      <p className="mt-2 text-slate-400">
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

function toneClass(value?: number): string {
  if (value == null || value === 0) return "text-slate-100";
  return value > 0 ? "text-emerald-300" : "text-red-300";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
