/**
 * PlatformRootCauseService — PRD 7 / ADR-164 F9 (§86-§92, §35, CA7/CA8): correlação de
 * causa provável.
 *
 * Quando a F6 aponta ANOMALIAS em várias camadas ao mesmo tempo (app × host × banco ×
 * fila × provider), o operador precisa de uma LEITURA — "o p95 subiu junto com a latência
 * do banco" é mais acionável que sete alertas soltos. Este serviço COMPÕE as anomalias
 * (não recalcula: reusa `PlatformBaselineService.anomalies`) e aplica um conjunto
 * DETERMINÍSTICO de regras sintoma→causa-provável, produzindo HIPÓTESES ranqueadas.
 *
 * GUARDRAILS DUROS:
 *   - §35 — o resultado é SEMPRE hipótese (`basis:"correlation"`) com confiança, NUNCA
 *     veredito de causa. Correlação não é causa, e isso é dito no payload.
 *   - RN-PRC-6 — sinal ausente não vira causa: sem anomalia → sem hipótese (não inventa).
 *   - CA8 — correlação com deploy é declarada `not_available` enquanto não houver
 *     telemetria de deploy/commit (a F0 provou que não existe: version 0.0.0, sem SHA).
 *   - Sem LLM (§56/§57 — determinístico antes de qualquer IA).
 *   - RN-PRC-4/§46 — GLOBAL (Admin Master), sem organization_id.
 *   - Determinístico (`now` injetável; ordem de regras fixa).
 */
import { PlatformBaselineService } from "./PlatformBaselineService.js";

type Dir = "above" | "below";
interface Sym { metric: string; dir?: Dir }

// Regras sintoma→causa (ordem fixa = ranqueamento determinístico do empate).
// `all`: todos os sintomas presentes; `label`: causa provável; `hint`: pista ADVISÓRIA
// (nunca uma execução — D6/RN-PRC).
const RULES: { cause: string; all: Sym[]; label: string; hint: string }[] = [
  { cause: "db_contention", all: [{ metric: "app.p95", dir: "above" }, { metric: "db.probe_ms", dir: "above" }],
    label: "Contenção no banco", hint: "Investigar queries lentas/locks e o WAL antes de qualquer redimensionamento." },
  { cause: "cpu_saturation", all: [{ metric: "app.p95", dir: "above" }, { metric: "host.load1m", dir: "above" }],
    label: "Saturação de CPU", hint: "Verificar carga por core (headroom F7) e picos de processamento síncrono." },
  { cause: "event_loop_blocking", all: [{ metric: "app.p95", dir: "above" }, { metric: "proc.eventloop_lag", dir: "above" }],
    label: "Bloqueio do event-loop", hint: "Procurar trabalho síncrono/CPU-bound no caminho da request." },
  { cause: "queue_backpressure", all: [{ metric: "queue.pending", dir: "above" }, { metric: "app.error_rate", dir: "above" }],
    label: "Backpressure na fila", hint: "Um downstream/provider falhando pode estar represando a fila." },
  { cause: "dependency_errors", all: [{ metric: "app.error_rate", dir: "above" }],
    label: "Erros de dependência/provider", hint: "Conferir saúde de dependências (F4) antes de mexer em capacidade." },
  { cause: "memory_growth", all: [{ metric: "proc.rss", dir: "above" }],
    label: "Crescimento de memória", hint: "Observar tendência (forecast F8); possível vazamento se monotônico." },
];

export class PlatformRootCauseService {
  /**
   * Analisa as anomalias correntes e devolve hipóteses de causa ranqueadas por confiança.
   * `days` = janela do baseline. Sem anomalia → hipóteses vazias (honesto).
   */
  static analyze(opts: { now?: number; days?: number } = {}): any {
    const now = opts.now ?? Date.now();
    const anomRes = PlatformBaselineService.anomalies({ now, days: opts.days });
    const anomalies: any[] = anomRes.anomalies ?? [];
    const present = new Map<string, any>();
    for (const a of anomalies) present.set(a.metric, a);

    const matches = (s: Sym) => {
      const a = present.get(s.metric);
      if (!a) return false;
      return !s.dir || a.direction === s.dir;
    };

    const hypotheses: any[] = [];
    const explained = new Set<string>();
    for (const rule of RULES) {
      if (!rule.all.every(matches)) continue;
      const evidence = rule.all.map((s) => present.get(s.metric)).filter(Boolean);
      // Confiança da hipótese = a mais forte evidência, mas SEMPRE rotulada como hipótese.
      const anyHigh = evidence.some((e) => e.severity === "high");
      hypotheses.push({
        cause: rule.cause, label: rule.label, hint: rule.hint,
        basis: "correlation",                                   // §35 — nunca "causa comprovada"
        confidence: anyHigh ? "média-alta" : "média",           // hipótese: teto abaixo de "alta"
        evidence: evidence.map((e) => ({ metric: e.metric, direction: e.direction, z: e.z, severity: e.severity })),
        note: "Correlação, não causa comprovada — confirmar com investigação.",
      });
      for (const s of rule.all) explained.add(s.metric);
    }

    // Anomalias sem regra: reportadas como desvio não-explicado (não força causa — RN-PRC-6).
    const unexplained = anomalies
      .filter((a) => !explained.has(a.metric))
      .map((a) => ({ metric: a.metric, direction: a.direction, z: a.z, severity: a.severity, basis: "correlation" }));

    return {
      generatedAt: new Date(now).toISOString(),
      sampleWindowDays: anomRes.sampleWindowDays,
      anomaliesConsidered: anomalies.length,
      hypotheses,                                               // ranqueadas pela ordem das regras
      unexplainedDeviations: unexplained,
      deployCorrelation: { available: false, reason: "no_deploy_telemetry" }, // CA8 honesto
    };
  }
}

export default PlatformRootCauseService;
