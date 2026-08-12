/**
 * PlatformProtectionModeService — PRD 7 / ADR-164 F11 (§93-§98, §102, CA23, RN-PRC-7):
 * execução consciente de confiabilidade (Protection Mode).
 *
 * DERIVA uma POSTURA de confiabilidade da plataforma (NORMAL → CAUTIOUS → PROTECTED) a
 * partir da saúde operacional (F5) e do headroom (F7). A postura é uma LEITURA que o
 * Runtime PODE consultar pra ficar mais conservador sob estresse — mas:
 *
 *   - NÃO é um Policy Engine novo (D1/CA20): não decide autorização, não substitui o
 *     `ApprovalPolicyService`/`CommandExecutorService`. Só expõe estado derivado + um flag.
 *   - SHADOW-FIRST (§102): o flag `platform_protection_enforce_enabled` nasce DESLIGADO.
 *     Enquanto desligado, `active:false` — a postura é computada e reportada, mas NÃO altera
 *     comportamento nenhum. Ligar o enforcement é decisão humana explícita.
 *   - CA23 / RN-PRC-7 — **o Guard NUNCA sacrifica operação crítica**. Mesmo em PROTECTED,
 *     só trabalho ADIÁVEL de plataforma (captura de baseline pesada, digests não-urgentes,
 *     recomputações em lote) é candidato a adiar; operação de cliente/cobrança/execução
 *     confirmada segue sempre. `neverDefers` é explícito no payload.
 *
 * Sem LLM (§56). GLOBAL/Admin Master (§46). Entradas injetáveis → determinismo.
 */
import db from "./db.js";
import { OperationalHealthService } from "./OperationalHealthService.js";
import { CapacityHeadroomService } from "./CapacityHeadroomService.js";

const ENFORCE_KEY = "platform_protection_enforce_enabled"; // '1' liga o enforcement; default shadow

type Posture = "NORMAL" | "CAUTIOUS" | "PROTECTED";
const ZONE_STRESS: Record<string, number> = { HEALTHY: 0, OBSERVE: 1, PLAN: 2, ACT: 3, CRITICAL: 4 };

// Trabalho ADIÁVEL de PLATAFORMA — nunca operação de cliente (CA23).
const DEFERRABLE_UNDER_PROTECTION = [
  "captura de baseline pesada (F6)",
  "recomputações em lote não-urgentes",
  "digests/relatórios não-críticos",
];
// O que o Guard JAMAIS adia/derruba — invariante dura (RN-PRC-7/CA23).
const NEVER_DEFERS = [
  "operação crítica de cliente",
  "execução já autorizada/confirmada",
  "cobrança/pagamento e sua confirmação",
  "alertas críticos de saúde",
];

export class PlatformProtectionModeService {
  static isEnforcing(): boolean {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(ENFORCE_KEY) as any;
    return row?.value === "1";
  }
  static setEnforcing(on: boolean): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(ENFORCE_KEY, on ? "1" : "0");
  }

  /** Deriva a postura recomendada + se ela está ATIVA (só quando enforcing). */
  static assess(opts: { now?: number; health?: any; headroom?: any; enforcing?: boolean } = {}): any {
    const now = opts.now ?? Date.now();
    const health = opts.health ?? OperationalHealthService.snapshot({ now });
    const headroom = opts.headroom ?? CapacityHeadroomService.snapshot({ now });
    const enforcing = opts.enforcing ?? this.isEnforcing();

    const opState: string = health?.operational?.state ?? "unknown";
    // Pior zona de headroom entre os recursos observáveis (ignora NOT_AVAILABLE).
    let worstZoneStress = 0; let worstResource: string | null = null;
    for (const r of headroom?.resources ?? []) {
      if (!r.available) continue;
      const s = ZONE_STRESS[r.zone] ?? 0;
      if (s > worstZoneStress) { worstZoneStress = s; worstResource = r.resource; }
    }

    let state: Posture = "NORMAL";
    const evidence: any[] = [];
    if (opState === "degraded" || opState === "unavailable" || worstZoneStress >= ZONE_STRESS.CRITICAL) {
      state = "PROTECTED";
    } else if (opState === "watch" || worstZoneStress >= ZONE_STRESS.ACT) {
      state = "CAUTIOUS";
    }
    if (opState !== "unknown" && opState !== "healthy") evidence.push({ source: "operational_health", state: opState });
    if (worstResource) evidence.push({ source: "headroom", resource: worstResource, zoneStress: worstZoneStress });

    const active = enforcing && state !== "NORMAL";

    return {
      generatedAt: new Date(now).toISOString(),
      state, enforcing, active,                                   // active=false em shadow (§102)
      shadow: !enforcing,
      wouldDefer: state === "PROTECTED" ? DEFERRABLE_UNDER_PROTECTION : state === "CAUTIOUS" ? DEFERRABLE_UNDER_PROTECTION.slice(0, 1) : [],
      neverDefers: NEVER_DEFERS,                                  // CA23 — invariante dura
      evidence,
      note: enforcing
        ? (active ? `Enforcement LIGADO: postura ${state} ativa — só trabalho adiável de plataforma é diferido; operação crítica intacta.` : `Enforcement ligado, mas postura NORMAL — nada é diferido.`)
        : `Shadow (§102): postura ${state} é apenas reportada; enforcement desligado não altera comportamento.`,
    };
  }
}

export default PlatformProtectionModeService;
