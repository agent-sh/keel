// What each hook did lately, from the spans its runs leave in their turn's trace (a wait named "hook": its
// hook, event and file in the attributes, the time it took, its outcome; src/integrations/hooks.ts HookRun).
// One row a hook and event: runs, the 95th percentile of their time, failures (failed or timed out), the last run.
export const HOOK_RUNS_DAYS = 1;
export type HookRuns = { hook: string; event: string; file: string; runs: number; p95_ms: number; failures: number; last_ms: number; last_outcome: string };

// ?1: from when (ms). The spans of one day by their start (spans_start), never the whole table.
export const HOOK_RUNS_SQL = `
WITH r AS (
  SELECT json_extract(attrs, '$.hook') AS hook, json_extract(attrs, '$.event') AS event, COALESCE(json_extract(attrs, '$.file'), '') AS file,
         end_ms - start_ms AS ms, status, start_ms, json_extract(attrs, '$.outcome') AS outcome
  FROM spans WHERE kind = 'wait' AND name = 'hook' AND start_ms >= ?1 AND end_ms IS NOT NULL
), k AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY hook, event, file ORDER BY ms) AS rn, COUNT(*) OVER (PARTITION BY hook, event, file) AS n,
         ROW_NUMBER() OVER (PARTITION BY hook, event, file ORDER BY start_ms DESC) AS recent
  FROM r
)
SELECT hook, event, file, MAX(n) AS runs, MAX(CASE WHEN rn = (n * 95 + 99) / 100 THEN ms END) AS p95_ms,
       SUM(status = 'error') AS failures, MAX(start_ms) AS last_ms, MAX(CASE WHEN recent = 1 THEN outcome END) AS last_outcome
FROM k GROUP BY hook, event, file ORDER BY last_ms DESC LIMIT 200`;
