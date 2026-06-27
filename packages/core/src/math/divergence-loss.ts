/**
 * Divergence Loss (Impermanent Loss) calculation for Uniswap V3 concentrated liquidity positions.
 *
 * For a concentrated liquidity position with range [pL, pU]:
 * - The position behaves like a leveraged full-range position within its range
 * - Outside the range, the position is 100% one token
 *
 * We compare:
 *   V_hold = value if you just held the original tokens
 *   V_lp   = current value of the LP position
 *   DL     = (V_lp - V_hold) / V_hold  (negative means loss)
 */

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;

/**
 * Convert sqrtPriceX96 to a human-readable price ratio (token1/token0)
 * adjusted for token decimals.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price = sqrtPrice * sqrtPrice;
  // Adjust for decimals: price is in terms of token1 per token0
  const decimalAdjustment = 10 ** (decimals0 - decimals1);
  return price * decimalAdjustment;
}

/**
 * Convert a tick to a price (token1/token0)
 */
export function tickToPrice(tick: number): number {
  return 1.0001 ** tick;
}

/**
 * Convert tick to sqrtPrice (as a float, not X96)
 */
export function tickToSqrtPrice(tick: number): number {
  return 1.0001 ** (tick / 2);
}

/**
 * Calculate the token amounts for a V3 position given current price.
 *
 * For a position with liquidity L, range [tickLower, tickUpper], current tick:
 * - If current tick < tickLower: position is 100% token0
 * - If current tick > tickUpper: position is 100% token1
 * - If within range: mixed
 */
export function getTokenAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
): { amount0: bigint; amount1: bigint } {
  const sqrtPriceLower = BigInt(Math.floor(Math.sqrt(1.0001 ** tickLower) * Number(Q96)));
  const sqrtPriceUpper = BigInt(Math.floor(Math.sqrt(1.0001 ** tickUpper) * Number(Q96)));

  let amount0: bigint;
  let amount1: bigint;

  if (sqrtPriceX96 <= sqrtPriceLower) {
    // Current price is below range - all token0
    amount0 =
      (liquidity * Q96 * (sqrtPriceUpper - sqrtPriceLower)) / (sqrtPriceLower * sqrtPriceUpper);
    amount1 = 0n;
  } else if (sqrtPriceX96 >= sqrtPriceUpper) {
    // Current price is above range - all token1
    amount0 = 0n;
    amount1 = (liquidity * (sqrtPriceUpper - sqrtPriceLower)) / Q96;
  } else {
    // Current price is within range
    amount0 = (liquidity * Q96 * (sqrtPriceUpper - sqrtPriceX96)) / (sqrtPriceX96 * sqrtPriceUpper);
    amount1 = (liquidity * (sqrtPriceX96 - sqrtPriceLower)) / Q96;
  }

  return { amount0, amount1 };
}

/**
 * Derive entry sqrtPriceX96 from deposit amounts and tick range.
 * Used as fallback when historical state is not available from RPC.
 *
 * Given amount0, amount1, liquidity, tickLower, tickUpper, we can solve for the price
 * at which these amounts would produce this liquidity in this range.
 */
export function deriveEntryPriceFromAmounts(
  amount0: bigint,
  amount1: bigint,
  liquidity: bigint,
  tickLower: number,
  tickUpper: number,
): bigint {
  // If amount0 is 0, price was above upper tick
  if (amount0 === 0n) {
    const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);
    return BigInt(Math.floor(sqrtPriceUpper * Number(Q96)));
  }

  // If amount1 is 0, price was below lower tick
  if (amount1 === 0n) {
    const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
    return BigInt(Math.floor(sqrtPriceLower * Number(Q96)));
  }

  // Price is within range. Use the ratio of amounts to find the price.
  // For a V3 position within range:
  //   amount0 = L * (sqrtPU - sqrtP) / (sqrtP * sqrtPU)
  //   amount1 = L * (sqrtP - sqrtPL)
  // Solving for sqrtP:
  //   Let a = amount0, b = amount1, L = liquidity
  //   sqrtPL = sqrt(1.0001^tickLower), sqrtPU = sqrt(1.0001^tickUpper)
  //   From amount1: sqrtP = b/L + sqrtPL (using float approximation)

  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const L = Number(liquidity);
  const b = Number(amount1);

  const sqrtP = b / L + sqrtPriceLower;
  return BigInt(Math.floor(sqrtP * Number(Q96)));
}

/**
 * Calculate uncollected fees for a position.
 *
 * Uses the fee growth tracking from the pool and position.
 */
export function calculateUnclaimedFees(
  liquidity: bigint,
  feeGrowthInside0LastX128: bigint,
  feeGrowthInside1LastX128: bigint,
  feeGrowthInside0CurrentX128: bigint,
  feeGrowthInside1CurrentX128: bigint,
  tokensOwed0: bigint,
  tokensOwed1: bigint,
  decimals0: number,
  decimals1: number,
): { fees0: number; fees1: number } {
  // Calculate fee growth delta
  let feeGrowth0Delta: bigint;
  let feeGrowth1Delta: bigint;

  // Handle underflow (fee growth values can wrap around)
  if (feeGrowthInside0CurrentX128 >= feeGrowthInside0LastX128) {
    feeGrowth0Delta = feeGrowthInside0CurrentX128 - feeGrowthInside0LastX128;
  } else {
    feeGrowth0Delta = 2n ** 256n - feeGrowthInside0LastX128 + feeGrowthInside0CurrentX128;
  }

  if (feeGrowthInside1CurrentX128 >= feeGrowthInside1LastX128) {
    feeGrowth1Delta = feeGrowthInside1CurrentX128 - feeGrowthInside1LastX128;
  } else {
    feeGrowth1Delta = 2n ** 256n - feeGrowthInside1LastX128 + feeGrowthInside1CurrentX128;
  }

  // Unclaimed fees = (feeGrowthDelta * liquidity) / 2^128 + tokensOwed
  const unclaimed0 = (feeGrowth0Delta * liquidity) / Q128 + tokensOwed0;
  const unclaimed1 = (feeGrowth1Delta * liquidity) / Q128 + tokensOwed1;

  return {
    fees0: Number(unclaimed0) / 10 ** decimals0,
    fees1: Number(unclaimed1) / 10 ** decimals1,
  };
}

/**
 * Calculate the fee growth inside a tick range.
 * This is needed to compute uncollected fees.
 */
export function calculateFeeGrowthInside(
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  feeGrowthGlobal0X128: bigint,
  feeGrowthGlobal1X128: bigint,
  feeGrowthOutsideLower0X128: bigint,
  feeGrowthOutsideLower1X128: bigint,
  feeGrowthOutsideUpper0X128: bigint,
  feeGrowthOutsideUpper1X128: bigint,
): { feeGrowthInside0X128: bigint; feeGrowthInside1X128: bigint } {
  // Calculate fee growth below the lower tick
  let feeGrowthBelow0: bigint;
  let feeGrowthBelow1: bigint;
  if (currentTick >= tickLower) {
    feeGrowthBelow0 = feeGrowthOutsideLower0X128;
    feeGrowthBelow1 = feeGrowthOutsideLower1X128;
  } else {
    feeGrowthBelow0 = feeGrowthGlobal0X128 - feeGrowthOutsideLower0X128;
    feeGrowthBelow1 = feeGrowthGlobal1X128 - feeGrowthOutsideLower1X128;
  }

  // Calculate fee growth above the upper tick
  let feeGrowthAbove0: bigint;
  let feeGrowthAbove1: bigint;
  if (currentTick < tickUpper) {
    feeGrowthAbove0 = feeGrowthOutsideUpper0X128;
    feeGrowthAbove1 = feeGrowthOutsideUpper1X128;
  } else {
    feeGrowthAbove0 = feeGrowthGlobal0X128 - feeGrowthOutsideUpper0X128;
    feeGrowthAbove1 = feeGrowthGlobal1X128 - feeGrowthOutsideUpper1X128;
  }

  // Fee growth inside = global - below - above
  const feeGrowthInside0X128 = feeGrowthGlobal0X128 - feeGrowthBelow0 - feeGrowthAbove0;
  const feeGrowthInside1X128 = feeGrowthGlobal1X128 - feeGrowthBelow1 - feeGrowthAbove1;

  return { feeGrowthInside0X128, feeGrowthInside1X128 };
}
