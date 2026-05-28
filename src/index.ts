import { Command } from "commander";
import { loadConfig } from "./config";
import { createClient } from "./chain/client";
import { getAllPositions, type PositionData } from "./chain/positions";
import {
  getPoolAddress,
  getPoolState,
  getTickData,
  getTokenInfo,
} from "./chain/pools";
import {
  findOpenEvent,
  findCloseEvent,
  getPoolPriceAtBlock,
} from "./chain/events";
import {
  calculateDivergenceLoss,
  calculateUnclaimedFees,
  calculateFeeGrowthInside,
  calculateFullPnL,
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
  sqrtPriceX96ToPrice,
  type FullPnLResult,
} from "./math/divergence-loss";
import {
  upsertPosition,
  getPosition,
  insertSnapshot,
  getSnapshots,
} from "./db/store";
import {
  displayPositions,
  displayIL,
  displayPnL,
  displayHistory,
  formatNumber,
  formatPrice,
  formatPercent,
  formatUsd,
  type PositionDisplayData,
  type ILDisplayData,
  type PnLDisplayData,
  type SnapshotDisplayData,
} from "./display/table";
import { withRetry } from "./chain/rpc";
import type { Address } from "viem";

const program = new Command();

program
  .name("lp-tracker")
  .description(
    "Track ProjectX concentrated liquidity positions on HyperEVM and calculate divergence loss"
  )
  .version("1.0.0")
  .option("--json", "Output results as JSON (for agent/programmatic use)");

/** Check if --json flag is set globally */
function isJsonMode(): boolean {
  return process.argv.includes("--json");
}

/** Output data as JSON or call the display function */
function output(data: any, displayFn: () => void): void {
  if (isJsonMode()) {
    // In JSON mode, output only the structured data to stdout
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    displayFn();
  }
}

// In JSON mode, redirect all console.log/warn to stderr so stdout is clean JSON
if (isJsonMode()) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => console.error(...args);
  console.warn = (...args: any[]) => console.error(...args);
}

// ===== POSITIONS COMMAND =====
program
  .command("positions")
  .description("List all LP positions for the configured wallet (active and closed)")
  .action(async () => {
    const config = loadConfig();
    const client = createClient(config);

    if (!isJsonMode()) console.log(`Fetching positions for ${config.wallet}...`);

    const positions = await getAllPositions(
      client,
      config.contracts.positionManager,
      config.wallet
    );

    if (positions.length === 0) {
      output({ positions: [] }, () => console.log("No LP positions found for this wallet."));
      return;
    }

    const displayData: PositionDisplayData[] = [];
    const jsonData: any[] = [];

    for (const pos of positions) {
      const [token0Info, token1Info] = await Promise.all([
        getTokenInfo(client, pos.token0),
        getTokenInfo(client, pos.token1),
      ]);

      const poolAddress = await getPoolAddress(
        client,
        config.contracts.factory,
        pos.token0,
        pos.token1,
        pos.fee
      );

      const poolState = await getPoolState(client, poolAddress);

      const currentAmounts = getTokenAmounts(
        pos.liquidity,
        poolState.sqrtPriceX96,
        pos.tickLower,
        pos.tickUpper
      );

      const priceLower =
        1.0001 ** pos.tickLower *
        10 ** (token0Info.decimals - token1Info.decimals);
      const priceUpper =
        1.0001 ** pos.tickUpper *
        10 ** (token0Info.decimals - token1Info.decimals);

      const currentPrice = sqrtPriceX96ToPrice(
        poolState.sqrtPriceX96,
        token0Info.decimals,
        token1Info.decimals
      );

      const inRange =
        poolState.tick >= pos.tickLower && poolState.tick < pos.tickUpper;
      const isActive = pos.liquidity > 0n;

      const amount0Human = Number(currentAmounts.amount0) / 10 ** token0Info.decimals;
      const amount1Human = Number(currentAmounts.amount1) / 10 ** token1Info.decimals;

      displayData.push({
        tokenId: pos.tokenId.toString(),
        pair: `${token0Info.symbol}/${token1Info.symbol}`,
        fee: `${pos.fee / 10000}%`,
        tickRange: `${pos.tickLower} / ${pos.tickUpper}`,
        priceRange: `${formatPrice(priceLower)} - ${formatPrice(priceUpper)}`,
        liquidity: pos.liquidity.toString(),
        currentAmounts: isActive
          ? `${formatNumber(amount0Human)} ${token0Info.symbol}\n${formatNumber(amount1Human)} ${token1Info.symbol}`
          : "0 (closed)",
        inRange,
        status: isActive ? "active" : "closed",
      });

      jsonData.push({
        tokenId: pos.tokenId.toString(),
        token0: { address: pos.token0, symbol: token0Info.symbol, decimals: token0Info.decimals },
        token1: { address: pos.token1, symbol: token1Info.symbol, decimals: token1Info.decimals },
        fee: pos.fee,
        feePercent: pos.fee / 10000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        priceLower,
        priceUpper,
        currentPrice,
        liquidity: pos.liquidity.toString(),
        status: isActive ? "active" : "closed",
        inRange,
        currentAmount0: amount0Human,
        currentAmount1: amount1Human,
      });
    }

    output({ positions: jsonData }, () => displayPositions(displayData));
  });

// ===== PNL COMMAND (new - absolute P&L view) =====
program
  .command("pnl")
  .description("Show full P&L analysis (absolute gains, divergence loss, opportunity cost)")
  .argument("[tokenId]", "Specific position token ID (optional, shows all if omitted)")
  .action(async (tokenId?: string) => {
    const config = loadConfig();
    const client = createClient(config);

    if (!isJsonMode()) console.log(`Calculating P&L...`);

    const positions = await getAllPositions(
      client,
      config.contracts.positionManager,
      config.wallet
    );

    if (positions.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    const filteredPositions = tokenId
      ? positions.filter((p) => p.tokenId.toString() === tokenId)
      : positions;

    if (filteredPositions.length === 0) {
      console.log(`Position #${tokenId} not found.`);
      return;
    }

    const displayData: PnLDisplayData[] = [];
    const jsonPnlData: any[] = [];

    for (const pos of filteredPositions) {
      const [token0Info, token1Info] = await Promise.all([
        getTokenInfo(client, pos.token0),
        getTokenInfo(client, pos.token1),
      ]);

      const poolAddress = await getPoolAddress(
        client,
        config.contracts.factory,
        pos.token0,
        pos.token1,
        pos.fee
      );

      const poolState = await getPoolState(client, poolAddress);
      const isActive = pos.liquidity > 0n;

      // Find open event (entry amounts)
      let entryAmount0 = 0n;
      let entryAmount1 = 0n;
      let entryLiquidity = pos.liquidity;

      const posConfig = config.positions?.[pos.tokenId.toString()];
      const storedPos = getPosition(pos.tokenId.toString());
      const hasStoredEntry = storedPos?.entry_amount0 && storedPos.entry_amount0 !== "0";
      const hasStoredLiquidity = storedPos?.entry_liquidity && storedPos.entry_liquidity !== "0";
      if (hasStoredEntry && (hasStoredLiquidity || isActive)) {
        entryAmount0 = BigInt(storedPos.entry_amount0);
        entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
        if (hasStoredLiquidity) {
          entryLiquidity = BigInt(storedPos.entry_liquidity!);
        }
      } else {
        console.log(`  Finding entry data for position #${pos.tokenId}...`);
        const openEvent = await findOpenEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfig?.openTx
        );

        if (openEvent) {
          entryAmount0 = openEvent.amount0;
          entryAmount1 = openEvent.amount1;
          entryLiquidity = openEvent.liquidity;

          // Store for future use
          const entrySqrtPrice = deriveEntryPriceFromAmounts(
            entryAmount0,
            entryAmount1,
            entryLiquidity,
            pos.tickLower,
            pos.tickUpper
          );
          upsertPosition({
            token_id: pos.tokenId.toString(),
            token0: pos.token0,
            token1: pos.token1,
            token0_symbol: token0Info.symbol,
            token1_symbol: token1Info.symbol,
            token0_decimals: token0Info.decimals,
            token1_decimals: token1Info.decimals,
            fee: pos.fee,
            tick_lower: pos.tickLower,
            tick_upper: pos.tickUpper,
            entry_sqrt_price_x96: entrySqrtPrice.toString(),
            entry_block: Number(openEvent.blockNumber),
            entry_amount0: entryAmount0.toString(),
            entry_amount1: entryAmount1.toString(),
            entry_liquidity: entryLiquidity.toString(),
          });
        } else {
          console.warn(`  Could not find entry for position #${pos.tokenId}. Skipping.`);
          continue;
        }
      }

      // Get exit/current amounts and fees
      let exitAmount0 = 0n;
      let exitAmount1 = 0n;
      let feesCollected0 = 0n;
      let feesCollected1 = 0n;
      let exitSqrtPriceX96 = poolState.sqrtPriceX96;

      if (isActive) {
        // Active position: use current amounts
        const currentAmounts = getTokenAmounts(
          pos.liquidity,
          poolState.sqrtPriceX96,
          pos.tickLower,
          pos.tickUpper
        );
        exitAmount0 = currentAmounts.amount0;
        exitAmount1 = currentAmounts.amount1;

        // Calculate uncollected fees
        try {
          const [tickLowerData, tickUpperData] = await Promise.all([
            getTickData(client, poolAddress, pos.tickLower),
            getTickData(client, poolAddress, pos.tickUpper),
          ]);

          const feeGrowthInside = calculateFeeGrowthInside(
            pos.tickLower,
            pos.tickUpper,
            poolState.tick,
            poolState.feeGrowthGlobal0X128,
            poolState.feeGrowthGlobal1X128,
            tickLowerData.feeGrowthOutside0X128,
            tickLowerData.feeGrowthOutside1X128,
            tickUpperData.feeGrowthOutside0X128,
            tickUpperData.feeGrowthOutside1X128
          );

          const feeResult = calculateUnclaimedFees(
            pos.liquidity,
            pos.feeGrowthInside0LastX128,
            pos.feeGrowthInside1LastX128,
            feeGrowthInside.feeGrowthInside0X128,
            feeGrowthInside.feeGrowthInside1X128,
            pos.tokensOwed0,
            pos.tokensOwed1,
            token0Info.decimals,
            token1Info.decimals
          );

          feesCollected0 = BigInt(Math.floor(feeResult.fees0 * 10 ** token0Info.decimals));
          feesCollected1 = BigInt(Math.floor(feeResult.fees1 * 10 ** token1Info.decimals));
        } catch (e) {
          // Fees calculation may fail
        }
      } else {
        // Closed position: find the close event
        // Pass entry_block as fromBlock so the log scan starts there, not from block 0
        const entryBlock = storedPos?.entry_block
          ? BigInt(storedPos.entry_block)
          : undefined;
        console.log(`  Finding close data for position #${pos.tokenId}...`);
        const closeEvent = await findCloseEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfig?.closeTx,
          entryBlock
        );

        if (closeEvent) {
          exitAmount0 = closeEvent.amount0;
          exitAmount1 = closeEvent.amount1;
          feesCollected0 = closeEvent.collectedFees0;
          feesCollected1 = closeEvent.collectedFees1;

          // Get pool price at close block for accurate exit price
          const closePrice = await getPoolPriceAtBlock(
            client,
            poolAddress,
            closeEvent.blockNumber
          );
          if (closePrice) {
            exitSqrtPriceX96 = closePrice.sqrtPriceX96;
          }
        } else {
          console.warn(`  Could not find close event for #${pos.tokenId}. Using current price.`);
        }
      }

      // Calculate full P&L
      const pnl = calculateFullPnL({
        entryAmount0Raw: entryAmount0,
        entryAmount1Raw: entryAmount1,
        exitAmount0Raw: exitAmount0,
        exitAmount1Raw: exitAmount1,
        feesCollected0Raw: feesCollected0,
        feesCollected1Raw: feesCollected1,
        exitSqrtPriceX96,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        liquidity: entryLiquidity,
        decimals0: token0Info.decimals,
        decimals1: token1Info.decimals,
      });

      const t1sym = token1Info.symbol;
      const t0sym = token0Info.symbol;

      displayData.push({
        tokenId: pos.tokenId.toString(),
        pair: `${t0sym}/${t1sym}`,
        status: isActive ? "ACTIVE" : "CLOSED",
        entryPrice: `${formatPrice(pnl.entryPrice)} ${t1sym}/${t0sym}`,
        exitPrice: `${formatPrice(pnl.exitPrice)} ${t1sym}/${t0sym} (${formatPercent((pnl.exitPrice - pnl.entryPrice) / pnl.entryPrice)})`,
        deposited: `${formatNumber(pnl.entryAmount0, 4)} ${t0sym} + ${formatNumber(pnl.entryAmount1, 4)} ${t1sym}`,
        withdrawn: `${formatNumber(pnl.exitAmount0, 4)} ${t0sym} + ${formatNumber(pnl.exitAmount1, 4)} ${t1sym}`,
        entryValue: `${formatNumber(pnl.entryValue, 4)} ${t1sym}`,
        exitValue: `${formatNumber(pnl.exitValue, 4)} ${t1sym}`,
        holdValue: `${formatNumber(pnl.holdValue, 4)} ${t1sym}`,
        feesEarned: `${formatNumber(pnl.feesCollected0, 4)} ${t0sym} + ${formatNumber(pnl.feesCollected1, 4)} ${t1sym} (= ${formatNumber(pnl.feesValue, 4)} ${t1sym})`,
        absolutePnl: `${formatNumber(pnl.absolutePnl, 4)} ${t1sym} (${formatPercent(pnl.absolutePnlPercent)})`,
        divergenceLoss: `${pnl.divergenceLossPercent} (${formatNumber(pnl.exitValue - pnl.holdValue, 4)} ${t1sym})`,
        opportunityCost: `${formatNumber(pnl.opportunityCost, 4)} ${t1sym}`,
      });

      jsonPnlData.push({
        tokenId: pos.tokenId.toString(),
        pair: `${t0sym}/${t1sym}`,
        token0Symbol: t0sym,
        token1Symbol: t1sym,
        status: isActive ? "active" : "closed",
        entryPrice: pnl.entryPrice,
        exitPrice: pnl.exitPrice,
        priceChangePercent: (pnl.exitPrice - pnl.entryPrice) / pnl.entryPrice,
        entryAmount0: pnl.entryAmount0,
        entryAmount1: pnl.entryAmount1,
        exitAmount0: pnl.exitAmount0,
        exitAmount1: pnl.exitAmount1,
        feesCollected0: pnl.feesCollected0,
        feesCollected1: pnl.feesCollected1,
        feesValueInToken1: pnl.feesValue,
        entryValueInToken1: pnl.entryValue,
        exitValueInToken1: pnl.exitValue,
        holdValueInToken1: pnl.holdValue,
        absolutePnlInToken1: pnl.absolutePnl,
        absolutePnlPercent: pnl.absolutePnlPercent,
        divergenceLossPercent: pnl.divergenceLoss,
        opportunityCostInToken1: pnl.opportunityCost,
        netVsHodlPercent: pnl.netVsHodl,
        priceLower: pnl.priceLower,
        priceUpper: pnl.priceUpper,
      });
    }

    output({ positions: jsonPnlData }, () => displayPnL(displayData));
  });

// ===== IL COMMAND =====
program
  .command("il")
  .description("Calculate current divergence loss for positions")
  .argument("[tokenId]", "Specific position token ID (optional, shows all if omitted)")
  .action(async (tokenId?: string) => {
    const config = loadConfig();
    const client = createClient(config);
    const jsonIlData: any[] = [];

    if (!isJsonMode()) console.log(`Calculating divergence loss...`);

    const positions = await getAllPositions(
      client,
      config.contracts.positionManager,
      config.wallet
    );

    if (positions.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    const filteredPositions = tokenId
      ? positions.filter((p) => p.tokenId.toString() === tokenId)
      : positions;

    if (filteredPositions.length === 0) {
      console.log(`Position #${tokenId} not found.`);
      return;
    }

    const displayData: ILDisplayData[] = [];

    for (const pos of filteredPositions) {
      const [token0Info, token1Info] = await Promise.all([
        getTokenInfo(client, pos.token0),
        getTokenInfo(client, pos.token1),
      ]);

      const poolAddress = await getPoolAddress(
        client,
        config.contracts.factory,
        pos.token0,
        pos.token1,
        pos.fee
      );

      const poolState = await getPoolState(client, poolAddress);
      const isActive = pos.liquidity > 0n;
      const posConfigIL = config.positions?.[pos.tokenId.toString()];

      // Get entry price
      let entrySqrtPriceX96: bigint;
      let entryAmount0 = 0n;
      let entryAmount1 = 0n;
      const storedPos = getPosition(pos.tokenId.toString());

      if (storedPos?.entry_sqrt_price_x96) {
        entrySqrtPriceX96 = BigInt(storedPos.entry_sqrt_price_x96);
        entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
        entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
      } else {
        // Need to find entry - run event scan
        console.log(`  Finding entry data for position #${pos.tokenId}...`);
        const openEvent = await findOpenEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfigIL?.openTx
        );

        if (openEvent) {
          entryAmount0 = openEvent.amount0;
          entryAmount1 = openEvent.amount1;
          // Derive entry price from actual deposit amounts (most accurate)
          entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
            openEvent.amount0,
            openEvent.amount1,
            openEvent.liquidity,
            pos.tickLower,
            pos.tickUpper
          );

          // Store for future use
          upsertPosition({
            token_id: pos.tokenId.toString(),
            token0: pos.token0,
            token1: pos.token1,
            token0_symbol: token0Info.symbol,
            token1_symbol: token1Info.symbol,
            token0_decimals: token0Info.decimals,
            token1_decimals: token1Info.decimals,
            fee: pos.fee,
            tick_lower: pos.tickLower,
            tick_upper: pos.tickUpper,
            entry_sqrt_price_x96: entrySqrtPriceX96.toString(),
            entry_block: Number(openEvent.blockNumber),
            entry_amount0: entryAmount0.toString(),
            entry_amount1: entryAmount1.toString(),
            entry_liquidity: openEvent.liquidity.toString(),
          });
        } else {
          console.warn(`  Could not find entry for position #${pos.tokenId}. Skipping.`);
          continue;
        }
      }

      // Determine current/exit sqrtPriceX96
      let currentSqrtPriceX96 = poolState.sqrtPriceX96;
      let exitAmount0 = 0n;
      let exitAmount1 = 0n;

      if (isActive) {
        const currentAmounts = getTokenAmounts(
          pos.liquidity,
          poolState.sqrtPriceX96,
          pos.tickLower,
          pos.tickUpper
        );
        exitAmount0 = currentAmounts.amount0;
        exitAmount1 = currentAmounts.amount1;
      } else {
        // Closed: find close event — start from entry_block to avoid scanning from block 0
        const entryBlockIL = storedPos?.entry_block
          ? BigInt(storedPos.entry_block)
          : undefined;
        const closeEvent = await findCloseEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfigIL?.closeTx,
          entryBlockIL
        );
        if (closeEvent) {
          exitAmount0 = closeEvent.amount0;
          exitAmount1 = closeEvent.amount1;
          const closePrice = await getPoolPriceAtBlock(
            client,
            poolAddress,
            closeEvent.blockNumber
          );
          if (closePrice) currentSqrtPriceX96 = closePrice.sqrtPriceX96;
        }
      }

      // Calculate DL
      const dlResult = calculateDivergenceLoss(
        pos.liquidity > 0n ? pos.liquidity : BigInt(storedPos?.entry_sqrt_price_x96 ? 1 : 1),
        pos.tickLower,
        pos.tickUpper,
        entrySqrtPriceX96,
        currentSqrtPriceX96,
        token0Info.decimals,
        token1Info.decimals
      );

      // For closed positions, override with actual amounts
      let valueLp: number;
      let valueHold: number;
      const exitPrice = sqrtPriceX96ToPrice(currentSqrtPriceX96, token0Info.decimals, token1Info.decimals);
      const entryAmt0H = Number(entryAmount0) / 10 ** token0Info.decimals;
      const entryAmt1H = Number(entryAmount1) / 10 ** token1Info.decimals;
      const exitAmt0H = Number(exitAmount0) / 10 ** token0Info.decimals;
      const exitAmt1H = Number(exitAmount1) / 10 ** token1Info.decimals;

      valueLp = exitAmt0H * exitPrice + exitAmt1H;
      valueHold = entryAmt0H * exitPrice + entryAmt1H;

      const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

      // Calculate fees
      let fees0 = 0;
      let fees1 = 0;
      if (isActive) {
        try {
          const [tickLowerData, tickUpperData] = await Promise.all([
            getTickData(client, poolAddress, pos.tickLower),
            getTickData(client, poolAddress, pos.tickUpper),
          ]);

          const feeGrowthInside = calculateFeeGrowthInside(
            pos.tickLower,
            pos.tickUpper,
            poolState.tick,
            poolState.feeGrowthGlobal0X128,
            poolState.feeGrowthGlobal1X128,
            tickLowerData.feeGrowthOutside0X128,
            tickLowerData.feeGrowthOutside1X128,
            tickUpperData.feeGrowthOutside0X128,
            tickUpperData.feeGrowthOutside1X128
          );

          const feeResult = calculateUnclaimedFees(
            pos.liquidity,
            pos.feeGrowthInside0LastX128,
            pos.feeGrowthInside1LastX128,
            feeGrowthInside.feeGrowthInside0X128,
            feeGrowthInside.feeGrowthInside1X128,
            pos.tokensOwed0,
            pos.tokensOwed1,
            token0Info.decimals,
            token1Info.decimals
          );

          fees0 = feeResult.fees0;
          fees1 = feeResult.fees1;
        } catch (e) {
          // Fees calculation may fail
        }
      }

      const feesValue = fees0 * exitPrice + fees1;
      const netVsHodl = valueHold > 0 ? (valueLp + feesValue - valueHold) / valueHold : 0;

      const priceLower =
        1.0001 ** pos.tickLower *
        10 ** (token0Info.decimals - token1Info.decimals);
      const priceUpper =
        1.0001 ** pos.tickUpper *
        10 ** (token0Info.decimals - token1Info.decimals);

      displayData.push({
        tokenId: pos.tokenId.toString(),
        pair: `${token0Info.symbol}/${token1Info.symbol}`,
        entryPrice: formatPrice(dlResult.entryPrice),
        currentPrice: formatPrice(exitPrice),
        priceRange: `${formatPrice(priceLower)} - ${formatPrice(priceUpper)}`,
        divergenceLoss: `${(divergenceLoss * 100).toFixed(4)}%`,
        valueLp: `${formatNumber(valueLp, 4)} ${token1Info.symbol}`,
        valueHold: `${formatNumber(valueHold, 4)} ${token1Info.symbol}`,
        fees: `${formatNumber(fees0, 4)} ${token0Info.symbol}\n${formatNumber(fees1, 4)} ${token1Info.symbol}`,
        netPnl: `${(netVsHodl * 100).toFixed(4)}% (${formatNumber(valueLp + feesValue - valueHold, 4)} ${token1Info.symbol})`,
      });

      jsonIlData.push({
        tokenId: pos.tokenId.toString(),
        pair: `${token0Info.symbol}/${token1Info.symbol}`,
        token0Symbol: token0Info.symbol,
        token1Symbol: token1Info.symbol,
        status: isActive ? "active" : "closed",
        entryPrice: dlResult.entryPrice,
        currentPrice: exitPrice,
        priceLower,
        priceUpper,
        divergenceLossPercent: divergenceLoss,
        valueLpInToken1: valueLp,
        valueHoldInToken1: valueHold,
        fees0,
        fees1,
        feesValueInToken1: feesValue,
        netVsHodlPercent: netVsHodl,
        netVsHodlInToken1: valueLp + feesValue - valueHold,
      });
    }

    output({ positions: jsonIlData }, () => displayIL(displayData));
  });

// ===== SNAPSHOT COMMAND =====
program
  .command("snapshot")
  .description("Take a snapshot of all active positions and store to database")
  .action(async () => {
    const config = loadConfig();
    const client = createClient(config);

    console.log(`Taking snapshot for ${config.wallet}...`);

    const positions = await getAllPositions(
      client,
      config.contracts.positionManager,
      config.wallet
    );

    if (positions.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    let snapshotCount = 0;

    for (const pos of positions) {
      // Skip positions with 0 liquidity (closed)
      if (pos.liquidity === 0n) {
        console.log(`  Skipping position #${pos.tokenId} (closed)`);
        continue;
      }

      const [token0Info, token1Info] = await Promise.all([
        getTokenInfo(client, pos.token0),
        getTokenInfo(client, pos.token1),
      ]);

      const poolAddress = await getPoolAddress(
        client,
        config.contracts.factory,
        pos.token0,
        pos.token1,
        pos.fee
      );

      const poolState = await getPoolState(client, poolAddress);

      // Get or determine entry price
      let entrySqrtPriceX96: bigint | null = null;
      let entryAmount0 = 0n;
      let entryAmount1 = 0n;

      const posConfigSnap = config.positions?.[pos.tokenId.toString()];
      const storedPos = getPosition(pos.tokenId.toString());
      if (storedPos?.entry_sqrt_price_x96) {
        entrySqrtPriceX96 = BigInt(storedPos.entry_sqrt_price_x96);
        entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
        entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
      } else {
        console.log(`  Finding entry data for position #${pos.tokenId}...`);
        const openEvent = await findOpenEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfigSnap?.openTx
        );

        if (openEvent) {
          entryAmount0 = openEvent.amount0;
          entryAmount1 = openEvent.amount1;
          entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
            openEvent.amount0,
            openEvent.amount1,
            openEvent.liquidity,
            pos.tickLower,
            pos.tickUpper
          );

          upsertPosition({
            token_id: pos.tokenId.toString(),
            token0: pos.token0,
            token1: pos.token1,
            token0_symbol: token0Info.symbol,
            token1_symbol: token1Info.symbol,
            token0_decimals: token0Info.decimals,
            token1_decimals: token1Info.decimals,
            fee: pos.fee,
            tick_lower: pos.tickLower,
            tick_upper: pos.tickUpper,
            entry_sqrt_price_x96: entrySqrtPriceX96.toString(),
            entry_block: Number(openEvent.blockNumber),
            entry_amount0: entryAmount0.toString(),
            entry_amount1: entryAmount1.toString(),
            entry_liquidity: openEvent.liquidity.toString(),
          });
        } else {
          console.warn(`  Could not find entry for #${pos.tokenId}. Using current price.`);
          entrySqrtPriceX96 = poolState.sqrtPriceX96;
          const currentAmounts = getTokenAmounts(
            pos.liquidity,
            poolState.sqrtPriceX96,
            pos.tickLower,
            pos.tickUpper
          );
          entryAmount0 = currentAmounts.amount0;
          entryAmount1 = currentAmounts.amount1;
        }
      }

      // Calculate current state
      const currentAmounts = getTokenAmounts(
        pos.liquidity,
        poolState.sqrtPriceX96,
        pos.tickLower,
        pos.tickUpper
      );

      const exitPrice = sqrtPriceX96ToPrice(poolState.sqrtPriceX96, token0Info.decimals, token1Info.decimals);
      const entryAmt0H = Number(entryAmount0) / 10 ** token0Info.decimals;
      const entryAmt1H = Number(entryAmount1) / 10 ** token1Info.decimals;
      const curAmt0H = Number(currentAmounts.amount0) / 10 ** token0Info.decimals;
      const curAmt1H = Number(currentAmounts.amount1) / 10 ** token1Info.decimals;

      const valueLp = curAmt0H * exitPrice + curAmt1H;
      const valueHold = entryAmt0H * exitPrice + entryAmt1H;
      const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

      // Calculate fees
      let fees0 = 0;
      let fees1 = 0;
      try {
        const [tickLowerData, tickUpperData] = await Promise.all([
          getTickData(client, poolAddress, pos.tickLower),
          getTickData(client, poolAddress, pos.tickUpper),
        ]);

        const feeGrowthInside = calculateFeeGrowthInside(
          pos.tickLower,
          pos.tickUpper,
          poolState.tick,
          poolState.feeGrowthGlobal0X128,
          poolState.feeGrowthGlobal1X128,
          tickLowerData.feeGrowthOutside0X128,
          tickLowerData.feeGrowthOutside1X128,
          tickUpperData.feeGrowthOutside0X128,
          tickUpperData.feeGrowthOutside1X128
        );

        const feeResult = calculateUnclaimedFees(
          pos.liquidity,
          pos.feeGrowthInside0LastX128,
          pos.feeGrowthInside1LastX128,
          feeGrowthInside.feeGrowthInside0X128,
          feeGrowthInside.feeGrowthInside1X128,
          pos.tokensOwed0,
          pos.tokensOwed1,
          token0Info.decimals,
          token1Info.decimals
        );

        fees0 = feeResult.fees0;
        fees1 = feeResult.fees1;
      } catch (e) {
        console.warn(`  Could not calculate fees for #${pos.tokenId}`);
      }

      const feesValue = fees0 * exitPrice + fees1;
      const netPnl = (valueLp - valueHold) + feesValue;

      // Store snapshot
      insertSnapshot({
        token_id: pos.tokenId.toString(),
        timestamp: new Date().toISOString(),
        liquidity: pos.liquidity.toString(),
        current_sqrt_price_x96: poolState.sqrtPriceX96.toString(),
        current_tick: poolState.tick,
        current_amount0: curAmt0H.toString(),
        current_amount1: curAmt1H.toString(),
        entry_amount0: entryAmt0H.toString(),
        entry_amount1: entryAmt1H.toString(),
        value_lp: valueLp,
        value_hold: valueHold,
        divergence_loss: divergenceLoss,
        fees0,
        fees1,
        fees_value: feesValue,
        net_pnl: netPnl,
      });

      snapshotCount++;
      console.log(
        `  Snapshot saved for #${pos.tokenId} (${token0Info.symbol}/${token1Info.symbol}) - DL: ${(divergenceLoss * 100).toFixed(4)}%`
      );
    }

    console.log(`\nDone! ${snapshotCount} snapshot(s) saved.`);
  });

// ===== HISTORY COMMAND =====
program
  .command("history")
  .description("Show historical divergence loss from stored snapshots")
  .argument("<tokenId>", "Position token ID")
  .option("-n, --limit <number>", "Number of snapshots to show", "20")
  .action(async (tokenId: string, options: { limit: string }) => {
    const storedPos = getPosition(tokenId);
    if (!storedPos) {
      console.log(
        `No stored data for position #${tokenId}. Run 'snapshot' first.`
      );
      return;
    }

    const snapshots = getSnapshots(tokenId, parseInt(options.limit));

    if (snapshots.length === 0) {
      console.log(
        `No snapshots found for position #${tokenId}. Run 'snapshot' first.`
      );
      return;
    }

    const pair = `${storedPos.token0_symbol}/${storedPos.token1_symbol}`;
    const decimals0 = storedPos.token0_decimals || 18;
    const decimals1 = storedPos.token1_decimals || 18;

    const displayData: SnapshotDisplayData[] = snapshots
      .reverse()
      .map((snap) => {
        const currentPrice = sqrtPriceX96ToPrice(
          BigInt(snap.current_sqrt_price_x96),
          decimals0,
          decimals1
        );

        return {
          timestamp: new Date(snap.timestamp).toLocaleString(),
          currentPrice: formatPrice(currentPrice),
          divergenceLoss: `${(snap.divergence_loss * 100).toFixed(4)}%`,
          fees: `${formatNumber(snap.fees_value, 4)} ${storedPos.token1_symbol}`,
          netPnl: `${formatNumber(snap.net_pnl, 4)} ${storedPos.token1_symbol}`,
          valueLp: `${formatNumber(snap.value_lp, 4)} ${storedPos.token1_symbol}`,
        };
      });

    displayHistory(tokenId, pair, displayData);
  });

program.parse();
