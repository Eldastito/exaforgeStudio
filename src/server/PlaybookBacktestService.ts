/**
 * ADR-206 F5.5 — BACKTEST de playbook (ESTENDE `ProcessOutcomeContractService`/`PlaybookRegistryService` — sem motor novo, RN-F5-12).
 *
 * Pergunta que responde: "se esta VERSÃO do playbook (o contrato de sucesso/falha dela) já existisse, ela teria classificado o
 * histórico real do mesmo jeito que o que de fato aconteceu?". Reaplica `success/failure_conditions` da definição escolhida —
 * pelo MESMO avaliador do PRD 8 (`ProcessOutcomeContractService.verdictFor`) — às instâncias passadas do `process_type` e compara
 * com o desfecho real (concluída/medida = positivo; falhou = negativo).
 *
 * O que NÃO é (RN-F5-4/8, honestidade):
 *  - NÃO simula os passos do playbook nem diz que a versão nova teria dado resultado melhor — só mede se o CONTRATO dela
 *    concorda com o que aconteceu. Backtest ≠ promessa; a confiança nunca é "alta".
 *  - NÃO roda nem altera nada: read-only, sem FSM, sem tabela nova, sem LLM.
 *  - Os desfechos reais vêm da própria FSM do runtime, que já pode refletir o contrato antigo — por isso a concordância é
 *    evidência de coerência, não prova de causa.
 *
 * Regras duras:
 *  - Sem contrato na definição → `no_contract` (NÃO inventa — hoje os 3 playbooks de plataforma não trazem contrato).
 *  - Amostra mínima de casos DECIDIDOS (sucesso/falha pelo contrato) com desfecho real; abaixo → `insufficient_data`, sem veredito.
 *  - Veredito de coerência pelo limite de Wilson da taxa de concordância; limiares declarados, NÃO calibrados com dado real.
 *  - "Falso sucesso" (contrato diria sucesso e o caso falhou) é contado à parte: é o erro perigoso.
 *  - Instâncias em andamento/canceladas ficam de fora e são ditas. Isolado por empresa.
 */
import db from "./db.js";
import { ProcessOutcomeContractService } from "./ProcessOutcomeContractService.js";
import { wilsonInterval, intervalConfidenceLabel } from "./statsWilson.js";

export const BACKTEST_DEFAULTS = { minDecided: 10, consistentLower: 0.8, limit: 500 };

export type BacktestVerdict = "no_contract" | "no_history" | "insufficient_data" | "consistent_with_history" | "diverges_from_history" | "inconclusive";

const POSITIVE = new Set(["completed", "measured"]);
const NEGATIVE = new Set(["failed"]);

export class PlaybookBacktestService {
  static backtest(orgId: string, processType: string, opts: { definitionId?: string; minDecided?: number; limit?: number } = {}): any {
    const o = { ...BACKTEST_DEFAULTS, ...opts };
    if (!orgId || !processType) return { found: false, verdict: "no_history" as BacktestVerdict, error: "processType obrigatório." };

    const def = (opts.definitionId
      ? db.prepare("SELECT * FROM process_definitions WHERE id = ? AND organization_id = ? AND process_type = ?").get(opts.definitionId, orgId, processType)
      : db.prepare("SELECT * FROM process_definitions WHERE organization_id = ? AND process_type = ? ORDER BY version DESC LIMIT 1").get(orgId, processType)) as any;
    if (!def) return { found: false, verdict: "no_history" as BacktestVerdict, error: "Definição não encontrada." };

    const base = { found: true, processType, definition: { id: def.id, version: Number(def.version), active: !!def.active }, thresholds: { minDecided: o.minDecided, consistentLower: o.consistentLower }, calibrated: false };
    const contract = ProcessOutcomeContractService.verdictFor(def, { context_json: "{}", status: "x" });
    if (contract.verdict === "no_contract") {
      return { ...base, verdict: "no_contract" as BacktestVerdict, note: "Esta versão não define contrato de sucesso/falha: não há o que reaplicar ao histórico (não inventa).", caveats: CAVEATS };
    }

    const rows = db.prepare("SELECT * FROM process_instances WHERE organization_id = ? AND process_type = ? ORDER BY COALESCE(completed_at, failed_at, started_at) DESC LIMIT ?").all(orgId, processType, Math.max(1, Math.min(2000, Number(o.limit) || 500))) as any[];
    const terminal = rows.filter((r) => POSITIVE.has(r.status) || NEGATIVE.has(r.status));
    const notTerminal = rows.length - terminal.length;
    if (!terminal.length) return { ...base, verdict: "no_history" as BacktestVerdict, instances: { total: rows.length, terminal: 0, excluded: notTerminal }, caveats: CAVEATS };

    let agree = 0, falseSuccess = 0, falseFailure = 0, undecided = 0;
    const disagreements: Array<{ instanceId: string; actual: string; contractSays: string }> = [];
    for (const inst of terminal) {
      const v = ProcessOutcomeContractService.verdictFor(def, inst).verdict;
      const actualPositive = POSITIVE.has(inst.status);
      if (v === "success") { if (actualPositive) agree++; else { falseSuccess++; disagreements.push({ instanceId: inst.id, actual: inst.status, contractSays: v }); } }
      else if (v === "failure") { if (!actualPositive) agree++; else { falseFailure++; disagreements.push({ instanceId: inst.id, actual: inst.status, contractSays: v }); } }
      else undecided++;
    }
    const decided = agree + falseSuccess + falseFailure;
    const iv = wilsonInterval(agree, decided);
    let verdict: BacktestVerdict;
    if (decided < o.minDecided || !iv) verdict = "insufficient_data";
    else if (iv.lower >= o.consistentLower) verdict = "consistent_with_history";
    else if (iv.upper < o.consistentLower) verdict = "diverges_from_history";
    else verdict = "inconclusive";

    return {
      ...base, verdict,
      instances: { total: rows.length, terminal: terminal.length, decided, undecided, excluded: notTerminal },
      agreement: { agree, falseSuccess, falseFailure, rate: decided ? agree / decided : null, interval: iv ? { lower: iv.lower, upper: iv.upper } : null, confidence: intervalConfidenceLabel(iv) },
      coverage: terminal.length ? decided / terminal.length : null,
      disagreements: disagreements.slice(0, 20),
      caveats: CAVEATS,
    };
  }
}

const CAVEATS = [
  "Backtest não é promessa: mede se o contrato desta versão concorda com o que já aconteceu, não se os passos dela dariam resultado melhor.",
  "Os desfechos reais vêm do próprio runtime e podem já refletir o contrato anterior; concordância é coerência, não prova de causa.",
  "Limiares (amostra mínima e limite de coerência) não foram calibrados com dado real.",
];

export default PlaybookBacktestService;
