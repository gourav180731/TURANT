import { appendFileSync } from 'node:fs';

const LOG = 'C:/Users/91958/OneDrive/Desktop/TURANT/.diag-weight.log';
const log = (s: string) => appendFileSync(LOG, s + '\n');

log(`weight-distribution simulation ${new Date().toISOString()}`);

interface DelhiCell { cellId: string; areaCount: number; }
// Replicate exactly the generator's distribution math and count rows/cell over
// the full 97,457,009-row run (without touching the DB).
const N = 29_727;
const TARGET = 97_457_009;
const cells: DelhiCell[] = Array.from({ length: N }, (_, i) => ({
  cellId: `cell-${(0x9c81 + i).toString(16).toUpperCase()}`,
  areaCount: 3,
}));

// --- copy of buildCellWeights / buildCellPrefixSum / weightedPickIndex ----
function buildCellWeights(cList: readonly DelhiCell[]): number[] {
  const weights = new Array<number>(cList.length);
  for (let i = 0; i < cList.length; i++) {
    const cell = cList[i]!;
    const h = ((i * 2654435761) ^ (cell.cellId.charCodeAt(0) * 40503) ^ (cell.cellId.length * 6791)) >>> 0;
    const u = h / 4294967296;
    const z = u < 0.5
      ? Math.sqrt(-2 * Math.log(Math.max(u, 1e-9)))
      : -Math.sqrt(-2 * Math.log(Math.max(1 - u, 1e-9)));
    weights[i] = Math.max(0.1, Math.exp(z * 0.55));
  }
  return weights;
}
function buildCellPrefixSum(weights: number[]): number[] {
  const prefix = new Array<number>(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]!; prefix[i] = acc; }
  return prefix;
}
function weightedPickIndex(prefix: number[], totalWeight: number, counter: number): number {
  const h = ((counter * 2654435761) ^ (counter >>> 16)) >>> 0;
  const pos = (h / 4294967296) * totalWeight;
  let lo = 0, hi = prefix.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (prefix[mid]! <= pos) lo = mid + 1; else hi = mid; }
  return lo;
}
// -------------------------------------------------------------------------

// Simulate the LEGACY even-modulo distributor (the one that actually ran):
const legacy = new Array<number>(N).fill(0);
for (let n = 0; n < TARGET; n++) legacy[n % N]!++;
log('LEGACY even-modulo distributor (what produced the current DB):');
log(`  min=${Math.min(...legacy)} max=${Math.max(...legacy)} stddev=${Math.sqrt(legacy.reduce((a, v) => a + ((v - TARGET / N) ** 2), 0) / N).toFixed(2)}`);

// Simulate the CURRENT weighted distributor (buildCellWeights in the file):
const w = buildCellWeights(cells);
const prefix = buildCellPrefixSum(w);
const totalW = prefix[prefix.length - 1]!;
const weighted = new Array<number>(N).fill(0);
for (let n = 0; n < TARGET; n++) weighted[weightedPickIndex(prefix, totalW, n)]!++;
weighted.sort((a, b) => a - b);
log('CURRENT weighted distributor (buildCellWeights, deterministic hash):');
log(`  min=${weighted[0]} p25=${weighted[Math.floor(N * 0.25)]} p50=${weighted[Math.floor(N * 0.5)]} p75=${weighted[Math.floor(N * 0.75)]} max=${weighted[N - 1]}`);
log('  first 12 cells row counts: ' + weighted.slice(0, 12).join(', '));
log('  DISTINCT row-count values across all cells: ' + new Set(weighted).size);
log('  uniform? ' + (Math.max(...weighted) - Math.min(...weighted) <= 2));
log('DONE');