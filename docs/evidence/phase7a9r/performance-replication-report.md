# Performance Evidence & Replication Report (Phase 7A.9R)

- **Probe Reference**: `scripts/probes/phase7a9/rc-a-large-database-benchmark.mjs`
- **Raw Metric Data**: `docs/evidence/phase7a9r/large-database-performance-raw.csv`
- **Structured Evidence**: `docs/evidence/phase7a9r/large-database-performance.json`
- **Evidence Classification**: `REAL_ISOLATED_DSH_E2E`
- **Test Platform**: Windows 11 x64, Node.js v24.13.0, DSH v0.2.0-rc.2

---

## 1. Context and Audit Findings Addressed

The independent audit noted that in earlier evidence:
1. The recovery CSV contained 61 samples spanning ~1.916 seconds, whereas total restart latency was reported as ~3.5 seconds.
2. The explanation of when `dsh-perf-sampler` starts relative to Custom recovery was incomplete.
3. Cold-start recovery had only 1 recorded run.
4. The structural limitation of the synthetic 105 MiB database was not explicitly separated from a realistic 770k-entry dictionary.

## 2. Process Startup & Sampler Timeline Analysis

```
Timeline:
[0.000s] spawn('dsh', ['--profile', '...', ...])
   │
   ├─ External Process Bootstrap (~1.5s - 1.6s)
   │    • Windows process creation & Node.js binary initialization
   │    • V8 engine startup & ESM module resolution
   │    • Core framework initialization (@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app)
   │
[~1.600s] Cordis Loader applies plugins
   │    • dsh-perf-sampler.apply(ctx) begins:
   │         - lagInterval (10ms) & memInterval (25ms) start immediately
   │    • dsh-word-lookup.apply(ctx) executes:
   │         - dictionaryManager recovers active custom snapshot
   │         - PRAGMA integrity_check executed via companion worker
   │
[~3.500s] Web server outputs launch token URL
   │
[~3.550s] Playwright completes navigation & requests /api/test/perf-metrics
```

- **Unmeasured Pre-Plugin Interval**: The first ~1.5s is external Node.js engine and core framework bootstrapping. It is captured externally via high-resolution wall-clock timer (`performance.now()` from `spawn` to token URL).
- **In-Process Sampling Window**: Sampling begins synchronously during `dsh-perf-sampler.apply(ctx)`. The 60-80 samples (at 25ms intervals) cover the entire in-process dictionary recovery and verification window.
- **Memory Scope**: `process.memoryUsage().rss` is the total OS resident set size of the Node.js process. Because Node.js Worker threads share the process address space, Worker thread memory is included in process-wide RSS.
- **Incremental vs Absolute RSS**:
  - Baseline DSH process RSS: 294.32 MiB
  - Absolute Peak RSS: 312.66 MiB
  - Peak RSS Increment Above Baseline: 18.34 MiB

## 3. Replicated Cold-Start Recovery Multi-Run Evidence

Three independent cold-start restart iterations were executed with the 105 MiB active database in an isolated environment:

| Metric | Run 1 | Run 2 | Run 3 | SLA Contract | Verdict |
|---|---|---|---|---|---|
| **External Restart Latency** | 3,581 ms | 3,528 ms | 3,569 ms | Informational | **REPRODUCIBLE** |
| **In-Process Sampled Span** | 1,842 ms | 1,795 ms | 1,811 ms | Recovery window | **REPRODUCIBLE** |
| **Recovery Peak RSS** | 295.59 MiB | 295.16 MiB | 295.27 MiB | < 512 MiB | **PASS** |
| **Time to First Lookup** | 35 ms | 8 ms | 25 ms | Sub-second | **PASS** |
| **Event Loop P50** | 5.49 ms | 5.49 ms | 5.53 ms | Baseline | **PASS** |
| **Event Loop P95** | 11.29 ms | 9.87 ms | 9.82 ms | < 50 ms | **PASS** |
| **Event Loop P99** | 38.79 ms | 42.50 ms | 40.80 ms | <= 100 ms | **PASS** |
| **Max Event Loop Lag** | 52.17 ms | 64.98 ms | 54.37 ms | <= 500 ms | **PASS** |
| **Heartbeat Max Stall** | 52.17 ms | 64.98 ms | 54.37 ms | < 1000 ms | **PASS** |

## 4. Synthetic Benchmark Database Scope Limitation

- **Database Spec**: 110,301,184 bytes (105.19 MiB), 1,750 entries (each definition ~64 KiB), 1,750 morphological forms, B-tree indexes, `PRAGMA integrity_check: ok`.
- **Scope**: Rigorously validates memory buffering, streaming hashing, SQLite page allocations, and worker-offloaded integrity verification for files > 100 MiB.
- **Explicit Limitation**: Because it achieves 105 MiB via large definition payloads across 1,750 entries rather than 770,611 realistic entries, this test does **not** claim to measure B-tree traversal depth or memory behavior for the full public ECDICT corpus.
