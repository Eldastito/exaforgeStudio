import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { FalaTuBriefingTaskService } from "./FalaTuBriefingTaskService.js";

/**
 * ADR-154 F8.3 — briefing por WEB PUSH (porta de entrega sem mensageiro).
 *
 * Segunda porta do digest da ADR-151 F6: consome os MESMOS sinais
 * `falatu_daily_briefing` e o MESMO texto determinístico do canal WA
 * (FalaTuBriefingDigestService é a fonte única de janela/texto/sinal) — este
 * service só cuida do transporte Web Push e do seu dedupe próprio.
 *
 * Decisões e porquês:
 * - **Opt-in é a própria subscription** (não flag de org): assinar exige
 *   permissão explícita do browser + clique do usuário, e o push só vai pro
 *   PRÓPRIO usuário que assinou — mais forte que a flag org-level do WA
 *   (que precisa existir porque lá o outbound sai pelo canal da org).
 *   Desligar revoga as subscriptions (UPDATE, convenção nº 9).
 * - **VAPID por plataforma, persistido em DB** — subscriptions amarram na
 *   chave pública; trocar a chave invalida todas. Gerada no 1º uso.
 * - **Transporte injetável** (`opts.push`) — teste roda sem rede; produção
 *   faz lazy-import de `web-push` (convenção nº 11).
 * - **Best-effort** (convenção nº 7): falha de envio nunca derruba o pass;
 *   endpoint morto (404/410 do push service) é revogado automaticamente.
 * - **Dedupe de entrega separado do WA** (`falatu_push_deliveries`): as
 *   portas são independentes — o dono pode receber nos dois lugares.
 */

export type PushTransport = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  payloadJson: string,
) => Promise<void>;

export interface PushSendResult { sent: number; dead: number; skipped: number; reason?: string }

export class FalaTuPushService {
  /** Keypair VAPID da plataforma — cria na primeira chamada, depois só lê. */
  static async ensureVapid(): Promise<{ publicKey: string; privateKey: string }> {
    const row = db.prepare(`SELECT public_key, private_key FROM falatu_push_vapid WHERE id = 1`).get() as any;
    if (row) return { publicKey: row.public_key, privateKey: row.private_key };
    const webpush = (await import("web-push")).default;
    const keys = webpush.generateVAPIDKeys();
    try {
      db.prepare(`INSERT INTO falatu_push_vapid (id, public_key, private_key) VALUES (1, ?, ?)`).run(keys.publicKey, keys.privateKey);
    } catch (e: any) {
      // Corrida na primeira geração: outra chamada inseriu antes — usa a dela
      // (duas chaves diferentes quebrariam metade das subscriptions).
      if (!String(e?.code || "").includes("SQLITE_CONSTRAINT")) throw e;
    }
    const winner = db.prepare(`SELECT public_key, private_key FROM falatu_push_vapid WHERE id = 1`).get() as any;
    return { publicKey: winner.public_key, privateKey: winner.private_key };
  }

  /** Registra (ou reativa/transfere) a subscription do browser do usuário. */
  static subscribe(orgId: string, userId: string, subscription: any): { subscribed: true } {
    const endpoint = subscription?.endpoint;
    const p256dh = subscription?.keys?.p256dh;
    const auth = subscription?.keys?.auth;
    if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 2000) {
      throw new Error("subscription.endpoint inválido.");
    }
    if (typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
      throw new Error("subscription.keys (p256dh/auth) obrigatórias.");
    }
    const existing = db.prepare(`SELECT id FROM falatu_push_subscriptions WHERE endpoint = ?`).get(endpoint) as any;
    if (existing) {
      // Endpoint pertence a UM perfil de browser: se outra conta logou no
      // mesmo browser e assinou, a linha muda de dono em vez de duplicar.
      db.prepare(`UPDATE falatu_push_subscriptions SET organization_id = ?, user_id = ?, p256dh = ?, auth = ?, revoked_at = NULL WHERE id = ?`)
        .run(orgId, userId, p256dh, auth, existing.id);
    } else {
      db.prepare(`INSERT INTO falatu_push_subscriptions (id, organization_id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, userId, endpoint, p256dh, auth);
    }
    logAuthEvent(orgId, userId, null, "FALATU_PUSH_SUBSCRIBE", { endpointHost: new URL(endpoint).host });
    return { subscribed: true };
  }

  /** Desliga a porta do usuário: revoga todas as subscriptions ativas dele. */
  static disable(orgId: string, userId: string): { subscribed: false } {
    db.prepare(`UPDATE falatu_push_subscriptions SET revoked_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(orgId, userId);
    logAuthEvent(orgId, userId, null, "FALATU_PUSH_DISABLE", {});
    return { subscribed: false };
  }

  static async status(orgId: string, userId: string): Promise<{ subscribed: boolean; publicKey: string }> {
    const { publicKey } = await this.ensureVapid();
    return { subscribed: this.activeSubs(orgId, userId).length > 0, publicKey };
  }

  private static activeSubs(orgId: string, userId: string): any[] {
    return db.prepare(`SELECT * FROM falatu_push_subscriptions WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL`).all(orgId, userId);
  }

  private static async defaultTransport(): Promise<PushTransport> {
    const webpush = (await import("web-push")).default;
    const { publicKey, privateKey } = await this.ensureVapid();
    return async (sub, payloadJson) => {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payloadJson,
        { vapidDetails: { subject: "mailto:suporte@tesseractauto.com.br", publicKey, privateKey }, TTL: 12 * 3600 },
      );
    };
  }

  /**
   * Envia uma notificação pra TODAS as subscriptions ativas do usuário.
   * Nunca lança: endpoint morto (404/410) é revogado; outros erros só contam.
   */
  static async sendToUser(orgId: string, userId: string, payload: { title: string; body: string; url?: string }, opts?: { push?: PushTransport }): Promise<PushSendResult> {
    const subs = this.activeSubs(orgId, userId);
    if (!subs.length) return { sent: 0, dead: 0, skipped: 1, reason: "no_subscription" };
    const push = opts?.push || await this.defaultTransport();
    const json = JSON.stringify(payload);
    let sent = 0, dead = 0;
    for (const s of subs) {
      try {
        await push({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json);
        sent++;
        try { db.prepare(`UPDATE falatu_push_subscriptions SET last_success_at = CURRENT_TIMESTAMP WHERE id = ?`).run(s.id); } catch { /* noop */ }
      } catch (e: any) {
        const code = Number(e?.statusCode || 0);
        if (code === 404 || code === 410) {
          dead++;
          try { db.prepare(`UPDATE falatu_push_subscriptions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).run(s.id); } catch { /* noop */ }
        } else {
          console.error("[FalaTuPush] envio falhou (best-effort):", e?.message || e);
        }
      }
    }
    return { sent, dead, skipped: 0 };
  }

  /** Payload de notificação a partir do texto do digest (sem os *asteriscos* do WA). */
  static notificationFromDigest(text: string): { title: string; body: string; url: string } {
    return { title: "FalaTu — seu resumo de hoje", body: text.replace(/\*/g, ""), url: "/" };
  }

  private static alreadySent(orgId: string, userId: string, dateSP: string): boolean {
    return !!db.prepare(`SELECT 1 FROM falatu_push_deliveries WHERE organization_id = ? AND user_id = ? AND briefing_date = ?`).get(orgId, userId, dateSP);
  }

  private static markSent(orgId: string, userId: string, dateSP: string): void {
    try {
      db.prepare(`INSERT INTO falatu_push_deliveries (id, organization_id, user_id, briefing_date) VALUES (?, ?, ?, ?)`)
        .run(randomUUID(), orgId, userId, dateSP);
    } catch (e: any) {
      if (e?.code !== "SQLITE_CONSTRAINT_UNIQUE") throw e;
    }
  }

  /**
   * Passe da org (Scheduler): mesmos sinais/janela/texto do canal WA, dedupe
   * próprio, e só pra quem TEM subscription ativa (a porta é a subscription).
   */
  static async runDigestPass(orgId: string, opts: { now: Date; force?: boolean; push?: PushTransport }): Promise<{ sent: number; skipped: number }> {
    const out = { sent: 0, skipped: 0 };
    const { dateSP, hourSP } = FalaTuBriefingDigestService.spParts(opts.now);
    if (!opts.force && (hourSP < 6 || hourSP >= 12)) return out;
    for (const sig of FalaTuBriefingDigestService.openBriefingsForDay(orgId, dateSP)) {
      const userId = sig.evidence.userId as string;
      if (!opts.force && this.alreadySent(orgId, userId, dateSP)) { out.skipped++; continue; }
      const { text, actionable } = FalaTuBriefingDigestService.digestText(sig.evidence);
      if (!actionable) { out.skipped++; continue; }
      const r = await this.sendToUser(orgId, userId, this.notificationFromDigest(text), { push: opts.push });
      if (r.sent > 0) { this.markSent(orgId, userId, dateSP); out.sent++; }
      else out.skipped++;
    }
    return out;
  }

  /** "Enviar agora" por push — ignora janela/dedupe; exige subscription + briefing do dia. */
  static async sendNow(orgId: string, userId: string, opts?: { now?: Date; push?: PushTransport }): Promise<{ sent: number; skipped: number; reason?: string }> {
    if (!this.activeSubs(orgId, userId).length) return { sent: 0, skipped: 1, reason: "no_subscription" };
    const { dateSP } = FalaTuBriefingDigestService.spParts(opts?.now || new Date());
    try { FalaTuBriefingTaskService.run(orgId, { date: dateSP }); } catch { /* best-effort */ }
    const sig = FalaTuBriefingDigestService.openBriefingsForDay(orgId, dateSP).find((s: any) => s.evidence.userId === userId);
    if (!sig) return { sent: 0, skipped: 1, reason: "no_briefing" };
    const { text, actionable } = FalaTuBriefingDigestService.digestText(sig.evidence);
    if (!actionable) return { sent: 0, skipped: 1, reason: "no_briefing" };
    const r = await this.sendToUser(orgId, userId, this.notificationFromDigest(text), { push: opts?.push });
    if (r.sent > 0) { this.markSent(orgId, userId, dateSP); return { sent: 1, skipped: 0 }; }
    return { sent: 0, skipped: 1, reason: r.reason || "push_failed" };
  }
}

export default FalaTuPushService;
