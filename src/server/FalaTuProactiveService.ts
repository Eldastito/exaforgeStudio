/**
 * FalaTuProactiveService — PRD 1 Fase 8 (§42-47): o Fala Tu fala PRIMEIRO.
 *
 * O briefing diário (ADR-151 F6) já cobre o "resumo da manhã". Esta camada é o
 * complemento EVENT-DRIVEN (§43): quando algo urgente aparece, avisa AGORA —
 * sem esperar o briefing. Fonte = Smart Inbox (Fase 3), não uma varredura nova
 * (CA15). Guardrails duros pra não virar spam:
 *   - só o URGENTE (§43): aprovações pendentes + riscos CRÍTICOS;
 *   - quiet hours (§45): fora da janela "acordado" (SP), não incomoda;
 *   - dedup por (usuário, item) (§44): cada item alerta UMA vez (marca só após
 *     envio bem-sucedido — retenta se o push falhar);
 *   - 1 push agregado (§44), nunca um por sinal;
 *   - opt-in por org (§46, convenção nº 10).
 * Herda o escopo por papel da Smart Inbox (um vendedor nunca é alertado de risco
 * financeiro).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { SmartInboxService, InboxItem } from "./SmartInboxService.js";
import { FalaTuPushService } from "./FalaTuPushService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { UxPreferencesService } from "./UxPreferencesService.js";

// ADR-163 F13 (§53/§68) — a janela "acordado" virou preferência
// (`UxPreferencesService`, defaults `DEFAULT_AWAKE_START/END` = 07h..22h SP).
// Sem config do dono, o comportamento é idêntico ao histórico (0 regressão).

export class FalaTuProactiveService {
  static enabled(orgId: string): boolean {
    const r = db.prepare(`SELECT COALESCE(falatu_proactive_alerts_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return !!(r && r.e);
  }

  private static itemKey(it: InboxItem): string { return `${it.category}:${it.id}`; }

  private static alreadySent(orgId: string, userId: string, key: string): boolean {
    return !!db.prepare(`SELECT 1 FROM falatu_proactive_deliveries WHERE organization_id = ? AND user_id = ? AND item_key = ?`).get(orgId, userId, key);
  }
  private static markSent(orgId: string, userId: string, key: string): void {
    try { db.prepare(`INSERT INTO falatu_proactive_deliveries (id, organization_id, user_id, item_key) VALUES (?, ?, ?, ?)`).run(randomUUID(), orgId, userId, key); }
    catch (e: any) { if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e; } // conflito = já entregue (best-effort)
  }

  /** Itens URGENTES da Smart Inbox (§43): aprovações pendentes + riscos críticos. */
  static selectUrgent(orgId: string, user: any, now: Date): InboxItem[] {
    const inbox = SmartInboxService.build(orgId, user, { now: now.getTime() });
    return [...inbox.categories.needsApproval, ...inbox.categories.risk.filter((i) => i.severity === "critical")]
      .sort((a, b) => b.score - a.score);
  }

  /** Redige o digest agregado (§44) a partir dos itens frescos. */
  private static compose(fresh: InboxItem[]): { title: string; body: string; url: string } {
    const nApp = fresh.filter((i) => i.category === "needsApproval").length;
    const nRisk = fresh.filter((i) => i.category === "risk").length;
    const heads: string[] = [];
    if (nApp) heads.push(`${nApp} aprovaç${nApp > 1 ? "ões" : "ão"} te esperando`);
    if (nRisk) heads.push(`${nRisk} risco${nRisk > 1 ? "s" : ""} crítico${nRisk > 1 ? "s" : ""}`);
    return {
      title: `ZapFlow — ${heads.join(" · ")}`,
      body: fresh.slice(0, 3).map((i) => `• ${i.title}`).join("\n") + (fresh.length > 3 ? `\n… e mais ${fresh.length - 3}` : ""),
      url: "/falatu/smart-inbox",
    };
  }

  /**
   * Entrega proativa pra UM usuário: quiet hours → dedup → 1 push → marca.
   * `push`/`now` injetáveis (determinístico). Marca só após envio (res.sent>0).
   */
  static async deliver(orgId: string, user: any, opts: { now?: Date; push?: any; force?: boolean } = {}): Promise<{ delivered: number; items: number; skipped: string | null; summary?: string }> {
    const now = opts.now || new Date();
    const userId = user?.userId || user?.id;
    const { hourSP } = FalaTuBriefingDigestService.spParts(now);
    // F13 — respeita a janela do dono (default = AWAKE_START/END quando não configurada).
    if (!opts.force && !UxPreferencesService.isAwake(orgId, hourSP)) return { delivered: 0, items: 0, skipped: "quiet_hours" };

    const urgent = this.selectUrgent(orgId, user, now);
    const fresh = urgent.filter((i) => !this.alreadySent(orgId, userId, this.itemKey(i)));
    if (!fresh.length) return { delivered: 0, items: 0, skipped: urgent.length ? "already_sent" : "nothing_urgent" };

    const payload = this.compose(fresh);
    const res = await FalaTuPushService.sendToUser(orgId, userId, payload, { push: opts.push });
    // Marca SÓ após envio bem-sucedido (§: retenta se o push falhou / sem inscrição).
    if (res.sent > 0) fresh.forEach((i) => this.markSent(orgId, userId, this.itemKey(i)));
    return { delivered: res.sent, items: fresh.length, skipped: res.sent ? null : (res.reason || "push_failed"), summary: payload.title };
  }
}
