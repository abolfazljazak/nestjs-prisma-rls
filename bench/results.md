# rowguard benchmark results

- Date: 2026-10-03
- Machine: 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz, 8 threads, 16 GB RAM
- Node v24.21.0; PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu in Docker on localhost
- Data: 100 tenants x 1000 notes; 2000 iterations after 200 warmup; 3 runs per scenario
- **Localhost: network round trips are far cheaper here than to a real database server.**

## Latency per operation (sequential)

| Scenario | What | p50 per run (ms) | p50 mean (ms) | spread (ms) | p95 mean (ms) | statements/op |
|---|---|---|---|---|---|---|
| A-read | plain Prisma, BYPASSRLS role, no transaction | 0.997 / 1.029 / 0.919 | 0.981 | 0.110 | 1.633 | 1.0 |
| B-read | RLS only: queries inside one transaction with one set_config | 0.938 / 0.990 / 1.028 | 0.985 | 0.090 | 1.510 | 1.0 |
| C-read | rowguard, one query per call | 3.762 / 3.782 / 3.731 | 3.758 | 0.050 | 5.354 | 4.0 |
| D-read | rowguard, 10 queries per user $transaction (per query) | 1.272 / 1.241 / 1.872 | 1.462 | 0.631 | 2.096 | 1.3 |
| A-write | plain Prisma create, superuser, explicit tenantId | 2.980 / 2.975 / 2.913 | 2.956 | 0.067 | 4.085 | 1.0 |
| C-write | rowguard create (dbgenerated default + WITH CHECK) | 5.528 / 5.637 / 4.708 | 5.291 | 0.929 | 8.072 | 4.0 |
| D-write | rowguard, 10 creates per user $transaction (per create) | 1.984 / 2.018 / 1.964 | 1.989 | 0.053 | 2.896 | 1.3 |

spread = max - min of the 3 run p50s.

## Differences vs. baseline

| Comparison | p50 difference | noise (max spread) | Verdict |
|---|---|---|---|
| B-read vs A-read | +0.004 ms | 0.110 ms | **within run-to-run variance: not meaningful** |
| C-read vs A-read | +2.777 ms | 0.110 ms | larger than run-to-run variance |
| D-read vs A-read | +0.480 ms | 0.631 ms | **within run-to-run variance: not meaningful** |
| C-write vs A-write | +2.335 ms | 0.929 ms | larger than run-to-run variance |
| D-write vs A-write | -0.967 ms | 0.067 ms | larger than run-to-run variance |

## Throughput (50 concurrent workers, pool of 10, 3 s)

| Scenario | queries/s |
|---|---|
| A-read | 7700 |
| C-read | 542 |
| D-read | 2227 |

## Index use with the RLS policy

Policy casting the setting (rowguard README form):
```
Bitmap Heap Scan on "Note"  (cost=914.46..4027.11 rows=79762 width=30)
  Recheck Cond: ("tenantId" = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
  ->  Bitmap Index Scan on "Note_tenantId_idx"  (cost=0.00..894.52 rows=79762 width=0)
        Index Cond: ("tenantId" = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
```
Policy casting the column (`"tenantId"::text = current_setting(...)`):
```
Gather  (cost=1000.00..4541.84 rows=896 width=30)
  Workers Planned: 1
  ->  Parallel Seq Scan on "Note"  (cost=0.00..3452.24 rows=527 width=30)
        Filter: (("tenantId")::text = current_setting('app.tenant_id'::text, true))
```
