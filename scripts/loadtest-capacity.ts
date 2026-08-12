/**
 * HARNESS de teste de carga — PRD 7 / ADR-164 F13 (§107): roda FORA de produção.
 *
 * NÃO é um teste de CI (sem prefixo `test:`): é a ferramenta que o operador roda contra um
 * servidor de STAGING pra medir o Capacity Envelope real. Ramba níveis de concorrência
 * contra um endpoint leve, mede p50/p95 e taxa de erro por nível, e imprime as amostras +
 * o envelope derivado (`CapacityEnvelopeService.deriveEnvelope`).
 *
 * Uso: BASE_URL=https://staging.exemplo npm run loadtest:capacity
 *   (env: BASE_URL, PATH=/api/health, LEVELS=10,25,50,100, REQUESTS_PER_LEVEL=200,
 *    SLO_P95_MS=500)
 *
 * IMPORTANTE (RN-PRC/§107): NÃO aponte pra produção. O resultado deve ser revisado por
 * humano e só então persistido (`CapacityEnvelopeService.store`) como envelope oficial.
 */
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TARGET_PATH = process.env.PATH_UNDER_TEST || "/api/health";
const LEVELS = (process.env.LEVELS || "10,25,50,100").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const REQS = parseInt(process.env.REQUESTS_PER_LEVEL || "200", 10);
const SLO_P95_MS = parseInt(process.env.SLO_P95_MS || "500", 10);

function pct(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}

async function oneRequest(url: string): Promise<{ ms: number; ok: boolean }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: "GET" });
    return { ms: Date.now() - t0, ok: r.status < 500 };
  } catch { return { ms: Date.now() - t0, ok: false }; }
}

async function runLevel(url: string, concurrency: number): Promise<{ rps: number; p95Ms: number; p50Ms: number; errorRatePct: number }> {
  const lat: number[] = []; let errors = 0;
  const start = Date.now();
  let inflight = 0; let done = 0; let launched = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inflight < concurrency && launched < REQS) {
        inflight++; launched++;
        oneRequest(url).then((res) => { lat.push(res.ms); if (!res.ok) errors++; inflight--; done++; if (done >= REQS) resolve(); else pump(); });
      }
    };
    pump();
  });
  const elapsedS = (Date.now() - start) / 1000 || 1;
  const sorted = lat.slice().sort((a, b) => a - b);
  return { rps: Math.round(REQS / elapsedS), p95Ms: pct(sorted, 0.95), p50Ms: pct(sorted, 0.5), errorRatePct: Math.round((errors / REQS) * 10000) / 100 };
}

async function main() {
  const url = `${BASE_URL}${TARGET_PATH}`;
  console.log(`Load test → ${url} | níveis ${LEVELS.join(",")} | ${REQS} req/nível | SLO p95 ${SLO_P95_MS}ms\n`);
  const samples: any[] = [];
  for (const level of LEVELS) {
    const s = await runLevel(url, level);
    samples.push({ rps: s.rps, p95Ms: s.p95Ms, errorRatePct: s.errorRatePct });
    console.log(`  conc=${level}\t~${s.rps} rps\tp50=${s.p50Ms}ms\tp95=${s.p95Ms}ms\terro=${s.errorRatePct}%`);
  }
  const { CapacityEnvelopeService } = await import("../src/server/CapacityEnvelopeService.js");
  const env = CapacityEnvelopeService.deriveEnvelope(samples, { sloP95Ms: SLO_P95_MS, at: Date.now() });
  console.log(`\nEnvelope derivado:\n${JSON.stringify(env, null, 2)}`);
  console.log(`\nRevise e, se aprovado, persista com CapacityEnvelopeService.store(...) (Admin Master).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
