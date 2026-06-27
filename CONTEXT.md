# Domain Context

## Position Lifecycle

A Position Lifecycle is the resolved state of a concentrated liquidity position from its open event through its current active state or closed exit. It includes entry amounts, entry liquidity, entry price, current or exit amounts, partial withdrawals, collected and pending fees, close transaction data when present, and the persistence policy that keeps those facts stable across runs.

Callers may need different projections of the Position Lifecycle. A cheap current-position projection supports list views; full lifecycle resolution supports P&L, divergence loss, snapshots, and tax flows.

## LP Economics

LP Economics is the canonical token1-denominated performance projection derived from Position Lifecycle facts. It owns entry value, LP value, HODL value, divergence loss, total fee value, absolute P&L, net-vs-HODL, price range, and human token amounts.

LP Economics uses total fees, meaning previously collected fees plus pending fees. For performance facts it uses exit amounts: closed-position close amounts, and active-position current amounts plus any withdrawn principal already returned by partial withdrawals.
