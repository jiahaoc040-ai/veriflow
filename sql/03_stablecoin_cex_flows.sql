-- Daily USDT + USDC inflow / outflow to centralized exchanges (all EVM chains in cex.flows)
-- Export as: stable_cex_flows.csv
SELECT
  date_trunc('day', block_time) AS day,
  SUM(CASE WHEN LOWER(flow_type) = 'inflow'  THEN amount_usd ELSE 0 END) AS inflow_usd,
  SUM(CASE WHEN LOWER(flow_type) = 'outflow' THEN amount_usd ELSE 0 END) AS outflow_usd
FROM cex.flows
WHERE token_symbol IN ('USDT', 'USDC')
  AND block_month >= DATE '2020-04-01'
  AND block_time >= TIMESTAMP '2020-04-01'
GROUP BY 1
ORDER BY 1
