# Domain Context

## Position Lifecycle

A Position Lifecycle is the resolved state of a concentrated liquidity position from its open event through its current active state or closed exit. It includes entry amounts, entry liquidity, entry price, current or exit amounts, partial withdrawals, collected and pending fees, close transaction data when present, and the persistence policy that keeps those facts stable across runs.

Callers may need different projections of the Position Lifecycle. A cheap current-position projection supports list views; full lifecycle resolution supports P&L, divergence loss, snapshots, and tax flows.
