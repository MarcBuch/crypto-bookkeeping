---
name: lp-position-validator
description: Use when the user asks to validate, audit, reconcile, verify, or independently fetch blockchain data for a ProjectX/HyperEVM LP position against this tool's displayed P&L, fees, or position amounts.
---

# LP Position Validator

Use this skill to audit one LP position by comparing the tool's displayed/cached values with independently fetched blockchain data. This is a tax/accounting verification workflow, not a normal performance check.

## Principles

- Prefer read-only validation. Do not call write-capable tracker services unless the user asks to update/cache/sync data.
- Treat `bun run apps/cli/src/index.ts --json pnl <tokenId>` as useful but not independent; it may refresh local SQLite caches while calculating.
- Independently fetch `IncreaseLiquidity`, `DecreaseLiquidity`, and `Collect` events from RPC/log RPC and recompute the values yourself.
- For closed positions, total fees are `sum(Collect amounts over lifecycle) - sum(DecreaseLiquidity principal over lifecycle)`, floored at zero per token.
- For active positions, include prior claimed fees from lifecycle `Collect` logs, subtract prior `DecreaseLiquidity` principal, and separately identify currently unclaimed/pending fees if you compute them.
- Report token amounts in native token units and values in `token1`, which is usually USDC or UBTC.
- Include a tax caveat: LP P&L/fees do not include gas, wallet-level cost basis, lot matching, or surrounding swaps unless explicitly analyzed.

## Required Inputs

Start from `config.json` in the repo root:

- `wallet`
- `contracts.positionManager`
- `positions[<tokenId>].openTx`
- `positions[<tokenId>].closeTx` when the position is closed
- `rpc` and `logsRpc` if present

If `openTx` or `closeTx` is missing for a position that needs it, use the `capital-flow-tracker` skill or ask one short clarification before proceeding.

## Read-Only Tool Comparison

To compare against the tool without triggering cache writes, read SQLite directly in read-only mode:

```bash
bun --eval "import { Database } from 'bun:sqlite'; const db = new Database('data/lp-tracker.db', { readonly: true }); console.log(JSON.stringify({ positions: db.query('select * from positions where token_id = ?').all('<TOKEN_ID>'), pnl_cache: db.query('select * from pnl_view_cache where token_id = ?').all('<TOKEN_ID>'), position_cache: db.query('select * from positions_view_cache where token_id = ?').all('<TOKEN_ID>') }, null, 2)); db.close();"
```

Use the cache only as the tool-side comparison. The independent side must come from RPC receipts/logs.

## Independent Blockchain Fetch

Run from the repo root. Use `packages/core` as the Bun working directory so `viem` resolves from `@lp-tracker/core` dependencies.

Replace the constants at the top before running. This script fetches only on-chain data and does not touch the tracker database.

```bash
bun --cwd packages/core --eval "import { createPublicClient, http, parseAbiItem, decodeEventLog } from 'viem';

const rpc = '<RPC_URL>';
const logsRpc = '<LOGS_RPC_URL>';
const positionManager = '<POSITION_MANAGER_ADDRESS>';
const tokenId = BigInt('<TOKEN_ID>');
const openTx = '<OPEN_TX_HASH>';
const closeTx = '<CLOSE_TX_HASH_OR_EMPTY>';

const chain = { id: 999, name: 'HyperEVM', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const client = createPublicClient({ chain, transport: http(rpc) });
const logClient = createPublicClient({ chain, transport: http(logsRpc || rpc) });

const incAbi = parseAbiItem('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)');
const decAbi = parseAbiItem('event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)');
const colAbi = parseAbiItem('event Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)');
const erc20Abi = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
const positionAbi = [{ type: 'function', name: 'positions', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
  { type: 'uint96' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }
] }];

function bigReplacer(_key, value) { return typeof value === 'bigint' ? value.toString() : value; }
function human(raw, decimals) { return Number(raw) / 10 ** decimals; }
function decodeLog(log, abi) { try { return decodeEventLog({ abi: [abi], data: log.data, topics: log.topics }); } catch { return null; } }

const [openReceipt, closeReceiptOrNull, positionRaw] = await Promise.all([
  client.getTransactionReceipt({ hash: openTx }),
  closeTx ? client.getTransactionReceipt({ hash: closeTx }) : Promise.resolve(null),
  client.readContract({ address: positionManager, abi: positionAbi, functionName: 'positions', args: [tokenId] }),
]);

const position = {
  token0: positionRaw[2], token1: positionRaw[3], fee: Number(positionRaw[4]), tickLower: Number(positionRaw[5]), tickUpper: Number(positionRaw[6]), liquidity: positionRaw[7], tokensOwed0: positionRaw[10], tokensOwed1: positionRaw[11],
};
const [symbol0, symbol1, decimals0, decimals1] = await Promise.all([
  client.readContract({ address: position.token0, abi: erc20Abi, functionName: 'symbol' }),
  client.readContract({ address: position.token1, abi: erc20Abi, functionName: 'symbol' }),
  client.readContract({ address: position.token0, abi: erc20Abi, functionName: 'decimals' }),
  client.readContract({ address: position.token1, abi: erc20Abi, functionName: 'decimals' }),
]);

const toBlock = closeReceiptOrNull?.blockNumber ?? await client.getBlockNumber();
const [increaseLogs, decreaseLogs, collectLogs] = await Promise.all([
  logClient.getLogs({ address: positionManager, event: incAbi, args: { tokenId }, fromBlock: openReceipt.blockNumber, toBlock }),
  logClient.getLogs({ address: positionManager, event: decAbi, args: { tokenId }, fromBlock: openReceipt.blockNumber, toBlock }),
  logClient.getLogs({ address: positionManager, event: colAbi, args: { tokenId }, fromBlock: openReceipt.blockNumber, toBlock }),
]);

let totalDecrease0 = 0n, totalDecrease1 = 0n, totalCollect0 = 0n, totalCollect1 = 0n;
for (const log of decreaseLogs) { totalDecrease0 += log.args.amount0; totalDecrease1 += log.args.amount1; }
for (const log of collectLogs) { totalCollect0 += log.args.amount0Collect; totalCollect1 += log.args.amount1Collect; }
const fees0 = totalCollect0 > totalDecrease0 ? totalCollect0 - totalDecrease0 : 0n;
const fees1 = totalCollect1 > totalDecrease1 ? totalCollect1 - totalDecrease1 : 0n;

const open = increaseLogs[0]?.args;
const close = decreaseLogs[decreaseLogs.length - 1]?.args;
if (!open) throw new Error('No IncreaseLiquidity event found for tokenId');
if (closeTx && !close) throw new Error('No DecreaseLiquidity event found for closed tokenId');

const Q96 = 2n ** 96n;
function sqrtPriceX96ToPrice(sqrtPriceX96, d0, d1) {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  return sqrtPrice * sqrtPrice * 10 ** (d0 - d1);
}
function derivePriceFromAmounts(amount0, amount1, liquidity, tickLower, tickUpper) {
  if (amount0 === 0n) return BigInt(Math.floor(Math.sqrt(1.0001 ** tickUpper) * Number(Q96)));
  if (amount1 === 0n) return BigInt(Math.floor(Math.sqrt(1.0001 ** tickLower) * Number(Q96)));
  const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
  const sqrtP = Number(amount1) / Number(liquidity) + sqrtPriceLower;
  return BigInt(Math.floor(sqrtP * Number(Q96)));
}

const entrySqrt = derivePriceFromAmounts(open.amount0, open.amount1, open.liquidity, position.tickLower, position.tickUpper);
const exitSource = close ?? { amount0: 0n, amount1: 0n, liquidity: open.liquidity };
const exitSqrt = close ? derivePriceFromAmounts(close.amount0, close.amount1, close.liquidity, position.tickLower, position.tickUpper) : entrySqrt;
const entryPrice = sqrtPriceX96ToPrice(entrySqrt, Number(decimals0), Number(decimals1));
const exitPrice = sqrtPriceX96ToPrice(exitSqrt, Number(decimals0), Number(decimals1));

const entryAmount0 = human(open.amount0, Number(decimals0));
const entryAmount1 = human(open.amount1, Number(decimals1));
const exitAmount0 = human(exitSource.amount0, Number(decimals0));
const exitAmount1 = human(exitSource.amount1, Number(decimals1));
const feesAmount0 = human(fees0, Number(decimals0));
const feesAmount1 = human(fees1, Number(decimals1));
const entryValueToken1 = entryAmount0 * entryPrice + entryAmount1;
const exitValueToken1 = exitAmount0 * exitPrice + exitAmount1;
const holdValueToken1 = entryAmount0 * exitPrice + entryAmount1;
const feesValueToken1 = feesAmount0 * exitPrice + feesAmount1;
const absolutePnlToken1 = exitValueToken1 + feesValueToken1 - entryValueToken1;
const absolutePnlPercent = entryValueToken1 ? absolutePnlToken1 / entryValueToken1 : 0;
const divergenceLossPercent = holdValueToken1 ? (exitValueToken1 - holdValueToken1) / holdValueToken1 : 0;
const opportunityCostToken1 = holdValueToken1 - exitValueToken1;
const netVsHodlPercent = holdValueToken1 ? (exitValueToken1 + feesValueToken1 - holdValueToken1) / holdValueToken1 : 0;

console.log(JSON.stringify({
  tokenId: tokenId.toString(),
  token0: { address: position.token0, symbol: symbol0, decimals: Number(decimals0) },
  token1: { address: position.token1, symbol: symbol1, decimals: Number(decimals1) },
  position: { fee: position.fee, tickLower: position.tickLower, tickUpper: position.tickUpper, currentLiquidity: position.liquidity, tokensOwed0: position.tokensOwed0, tokensOwed1: position.tokensOwed1 },
  openTx: { hash: openTx, blockNumber: openReceipt.blockNumber, status: openReceipt.status },
  closeTx: closeReceiptOrNull ? { hash: closeTx, blockNumber: closeReceiptOrNull.blockNumber, status: closeReceiptOrNull.status } : null,
  lifecycleLogs: {
    increaseCount: increaseLogs.length,
    decreaseCount: decreaseLogs.length,
    collectCount: collectLogs.length,
    increases: increaseLogs.map((log) => ({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, liquidity: log.args.liquidity, amount0: log.args.amount0, amount1: log.args.amount1 })),
    decreases: decreaseLogs.map((log) => ({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, liquidity: log.args.liquidity, amount0: log.args.amount0, amount1: log.args.amount1 })),
    collects: collectLogs.map((log) => ({ blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, recipient: log.args.recipient, amount0: log.args.amount0Collect, amount1: log.args.amount1Collect })),
    totalDecrease0, totalDecrease1, totalCollect0, totalCollect1, fees0, fees1,
  },
  reconciliation: {
    entryPrice, exitPrice, priceChangePercent: (exitPrice - entryPrice) / entryPrice,
    entryAmount0, entryAmount1, exitAmount0, exitAmount1, feesAmount0, feesAmount1,
    entryValueToken1, exitValueToken1, holdValueToken1, feesValueToken1,
    absolutePnlToken1, absolutePnlPercent, divergenceLossPercent, opportunityCostToken1, netVsHodlPercent,
  },
}, bigReplacer, 2));"
```

## Reconciliation Formulas

Use the same definitions as the tracker so the comparison is apples-to-apples:

- `entryValueInToken1 = entryAmount0 * entryPrice + entryAmount1`
- `exitValueInToken1 = exitAmount0 * exitPrice + exitAmount1`
- `holdValueInToken1 = entryAmount0 * exitPrice + entryAmount1`
- `feesValueInToken1 = feesCollected0 * exitPrice + feesCollected1`
- `absolutePnlInToken1 = exitValueInToken1 + feesValueInToken1 - entryValueInToken1`
- `absolutePnlPercent = absolutePnlInToken1 / entryValueInToken1`
- `divergenceLossPercent = (exitValueInToken1 - holdValueInToken1) / holdValueInToken1`
- `opportunityCostInToken1 = holdValueInToken1 - exitValueInToken1`
- `netVsHodlPercent = (exitValueInToken1 + feesValueInToken1 - holdValueInToken1) / holdValueInToken1`

Percent values are decimals in JSON. Multiply by 100 only for human-readable percentages.

## Report Format

Keep the answer accountant-friendly:

- State whether the tool values match the independently fetched data.
- Identify the pair, status, open tx/block, close tx/block, liquidity, and tokens owed.
- Show a table for entry deposit, exit principal, and fees by token.
- Show fee lifecycle details if there were multiple `Collect` events.
- Show P&L table with entry value, exit principal value, fees value, total exit value including fees, absolute P&L, and absolute P&L percent.
- Show HODL comparison with HODL value, opportunity cost before fees, divergence loss, net vs HODL amount, and net vs HODL percent.
- Explicitly mention any mismatch and likely cause, such as stale `pnl_view_cache`, missing prior collect, missing partial withdrawal, or different price source.
- End with the tax caveat about gas, cost basis, lot matching, and surrounding wallet transactions.

## Known Pitfalls

- A `Collect` event includes principal after a burn plus any fees. Do not treat all collected amounts as fees.
- Prior fee claims can occur before the close transaction. Scan from the open block to the close block, not only the close receipt.
- `closeTx` may also open the next reranged position. Filter logs by `tokenId`.
- Closed NFT positions keep `positions(tokenId)` readable but have `liquidity = 0` and `tokensOwed = 0` after collection.
- The tracker derives entry/exit prices from event amounts for closed reranges because pool `slot0` at transaction end can reflect later swaps or the next opened position.
- Avoid `bun test` from the repo root for verification; this repo's agent notes require `bun run test` from `packages/core` for code changes. This skill normally does not require tests because it is a documentation/config addition.
