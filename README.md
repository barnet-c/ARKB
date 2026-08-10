# ARKB

ARK 21Shares Bitcoin ETF (**ARKB**) creation/redemption arbitrage toolkit.

## What's inside

| Path | Description |
|------|-------------|
| [`ARKB-arb/sim.py`](ARKB-arb/sim.py) | Monte Carlo / GBM AP arbitrage simulator |
| [`ARKB-arb/node/`](ARKB-arb/node/) | Historical analysis, live monitor, web dashboard |
| [`ARKB-arb/PARAMETERS.md`](ARKB-arb/PARAMETERS.md) | Parameter sources and confidence levels |

## Quick start (Node)

```bash
cd ARKB-arb/node
npm install
npm test
npm run dashboard   # dry-run web UI on http://localhost:5001
npm run monitor     # dry-run terminal monitor
npm run analyze     # historical Yahoo Finance analysis
```

## Quick start (Python)

```bash
cd ARKB-arb
python sim.py --days 1 --no-chart
python sim.py --days 5
```

## Critical modeling note

**Never set `btcPerShare = ARKB_price / BTC_price`.**  
That identity forces NAV ≈ market mid and zeros measured premium/discount.  
Use ARK holdings CSV and/or the configured holdings-derived ratio instead.

## License

ISC (see `ARKB-arb/node/package.json`).
