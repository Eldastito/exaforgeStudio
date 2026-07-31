/**
 * Módulo Clínica — ENVIO AUTOMÁTICO DO RELATÓRIO MENSAL (ADR-080 Fase 33).
 *
 * Fecha o loop da Fase 17: em vez do gestor lembrar de baixar o PDF, o
 * Scheduler decide se hoje é o dia de envio configurado (default: dia 5
 * do mês seguinte) e dispara sozinho pra um destinatário definido em
 * `organization_settings.clinic_monthly_report_recipient_contact_id`
 * (owner/sócio/contador). PDF financeiro é sensível — envio automático
 * exige DECISÃO CONSCIENTE do gestor, então `enabled` default 0 (opt-in).
 *
 * Best-effort e não bloqueante: qualquer falha grava row `failed`/`skipped`
 * e loga auditoria — o Scheduler nunca trava em falha de 1 org.
 *
 * Guardrails LGPD (mesmo padrão da Fase 26 follow-up-notice):
 *   - `comunicacoes` do DESTINATÁRIO obrigatório (é o dono do canal que
 *     recebe a mensagem, não o paciente — mas ainda é envio ativo).
 *   - Sem `dados_sensiveis`: o relatório é AGREGADO (contagens, taxas,
 *     R$ total). Não expõe paciente específico. Base legítima Art.7 (III).
 *
 * Dedup por (org, month, status IN sent|queued). Um mês = um envio, mesmo
 * com o Scheduler rodando várias vezes no dia. `force:true` bypassa
 * (re-envio manual do painel).
 *
 * PDF salvo em `PRIVATE_MEDIA_DIR/monthly-reports/{orgId}/{uuid}.pdf` e
 * servido por URL assinada HMAC + `exp` de 15min — mesmo padrão do doc
 * clínico (ClinicDocumentDeliveryService, Fase K/18).
 *
 * Determinístico, isolado por `organization_id`.
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import db from "./db.js";
import { logAuthEvent, maskIdentifier } from "./auditLog.js";
import { LgpdService } from "./LgpdService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { ClinicMonthlyReportService, normalizeMonth } from "./ClinicMonthlyReportService.js";
import { JWT_SECRET } from "./config/secret.js";

const COMMS_CONSENT = "comunicacoes";
const DEFAULT_DAY = 5;
const MIN_DAY = 1;
const MAX_DAY = 28; // sempre existe em qualquer mês (evita 30/31 em fevereiro)
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");

// Segredo próprio pra assinar URL dos relatórios — rotacionando JWT_SECRET,
// URLs antigas param de funcionar (comportamento desejado).
const MEDIA_SIGNING_SECRET = crypto.createHash("sha256")
  .update(`${JWT_SECRET}:clinical_monthly_report_v1`).digest("hex");

export const MONTHLY_REPORT_DIR = path.join(
  process.env.DATA_DIR || process.cwd(),
  "private_media",
  "monthly-reports"
);
try { fs.mkdirSync(MONTHLY_REPORT_DIR, { recursive: true }); } catch { /* noop */ }

export type DeliveryStatus = "queued" | "sent" | "failed" | "skipped";

export interface MonthlyReportDelivery {
  id: string;
  organizationId: string;
  month: string;
  contactId: string | null;
  channelId: string | null;
  toIdentifier: string | null;
  status: DeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
  sentAt: string;
}

export type DocSender = (
  channelId: string,
  recipientIdentifier: string,
  fileUrl: string,
  fileName: string,
  caption?: string
) => Promise<any>;

function hydrate(r: any): MonthlyReportDelivery | null {
  if (!r) return null;
  return {
    id: r.id,
    organizationId: r.organization_id,
    month: r.month,
    contactId: r.contact_id ?? null,
    channelId: r.channel_id ?? null,
    toIdentifier: r.to_identifier ?? null,
    status: r.status,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    sentAt: r.sent_at,
  };
}

function readConfig(orgId: string): { enabled: boolean; day: number; recipientContactId: string | null } {
  try {
    const r = db.prepare(
      `SELECT clinic_monthly_report_enabled AS en,
              clinic_monthly_report_day AS day,
              clinic_monthly_report_recipient_contact_id AS recipient
         FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    const enabled = r != null && Number(r.en) === 1; // OPT-IN estrito
    const rawDay = Number(r?.day ?? DEFAULT_DAY);
    const day = Number.isFinite(rawDay)
      ? Math.max(MIN_DAY, Math.min(MAX_DAY, Math.floor(rawDay)))
      : DEFAULT_DAY;
    return { enabled, day, recipientContactId: r?.recipient || null };
  } catch { return { enabled: false, day: DEFAULT_DAY, recipientContactId: null }; }
}

function resolveChannel(orgId: string, contactChannelId: string | null): string | null {
  if (contactChannelId) {
    const c = db.prepare(`SELECT id, status FROM channels WHERE id = ? AND organization_id = ?`).get(contactChannelId, orgId) as any;
    if (c && c.status !== "disabled" && c.status !== "disconnected") return c.id;
  }
  const fb = db.prepare(
    `SELECT id FROM channels WHERE organization_id = ?
       AND status NOT IN ('disabled','disconnected')
      ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
  ).get(orgId) as any;
  return fb?.id || null;
}

function insertDelivery(row: {
  orgId: string; month: string; contactId: string | null;
  channelId: string | null; toIdentifier: string | null;
  status: DeliveryStatus; error?: string | null;
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO clinical_monthly_report_deliveries
       (id, organization_id, month, contact_id, channel_id, to_identifier, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, row.orgId, row.month, row.contactId,
    row.channelId, row.toIdentifier, row.status, row.error ?? null
  );
  return id;
}

// key = "{orgId}/{uuid}.pdf" — mesmo padrão isolamento por tenant do Fase 18
function safeStorageKey(storageKey: string): string {
  const s = String(storageKey || "");
  const parts = s.split("/");
  if (parts.length !== 2) throw new Error("Chave de arquivo inválida.");
  const [orgSeg, fileSeg] = parts;
  if (!/^[a-zA-Z0-9._-]+$/.test(orgSeg) || !/^[a-zA-Z0-9._-]+$/.test(fileSeg)) {
    throw new Error("Chave de arquivo inválida.");
  }
  if (path.basename(orgSeg) !== orgSeg || path.basename(fileSeg) !== fileSeg) {
    throw new Error("Chave de arquivo inválida.");
  }
  return `${orgSeg}/${fileSeg}`;
}

function renderCaption(businessName: string, monthLabel: string): string {
  return `Relatório mensal ${businessName} — ${monthLabel}. Documento gerado automaticamente.`;
}

export class ClinicMonthlyReportDeliveryService {
  /** URL assinada temporária pro provider baixar o PDF sem auth de sessão. */
  static signedUrl(storageKey: string, ttlMs = SIGNED_URL_TTL_MS, now = Date.now()): string {
    const key = safeStorageKey(storageKey);
    const exp = now + ttlMs;
    const sig = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${exp}`).digest("hex");
    const [orgSeg, fileSeg] = key.split("/");
    const rel = `/api/public/clinic/monthly-reports/${encodeURIComponent(orgSeg)}/${encodeURIComponent(fileSeg)}?exp=${exp}&sig=${sig}`;
    return APP_URL ? `${APP_URL}${rel}` : rel;
  }

  /** Verifica HMAC + expiração; devolve caminho absoluto no disco ou null. */
  static resolveSignedFile(storageKey: string, exp: string, sig: string, now = Date.now()): string | null {
    let key: string;
    try { key = safeStorageKey(storageKey); } catch { return null; }
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < now) return null;
    const expected = crypto.createHmac("sha256", MEDIA_SIGNING_SECRET).update(`${key}:${expMs}`).digest("hex");
    const a = Buffer.from(String(sig || ""), "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const file = path.join(MONTHLY_REPORT_DIR, key);
    return fs.existsSync(file) ? file : null;
  }

  static list(orgId: string, opts: { month?: string; limit?: number } = {}): MonthlyReportDelivery[] {
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 100));
    const rows = opts.month
      ? db.prepare(
          `SELECT * FROM clinical_monthly_report_deliveries
            WHERE organization_id = ? AND month = ?
            ORDER BY sent_at DESC, rowid DESC LIMIT ?`
        ).all(orgId, opts.month, limit) as any[]
      : db.prepare(
          `SELECT * FROM clinical_monthly_report_deliveries
            WHERE organization_id = ?
            ORDER BY sent_at DESC, rowid DESC LIMIT ?`
        ).all(orgId, limit) as any[];
    return rows.map((r) => hydrate(r)!).filter(Boolean);
  }

  /**
   * Envia (ou tenta enviar) o relatório mensal de 1 org.
   * Sempre grava row. Nunca lança. `sender` injetável.
   *
   * Fluxo:
   *   1. Normaliza mês (default: mês anterior)
   *   2. Toggle disabled → skipped disabled
   *   3. Sem recipient configurado → skipped no_recipient
   *   4. Recipient não existe/sem identifier → skipped/failed
   *   5. Dedup por (org, month, status IN sent|queued) — sem force devolve existente
   *   6. LGPD comms do destinatário → skipped
   *   7. Sem canal ativo → failed
   *   8. Renderiza PDF via ClinicMonthlyReportService.renderPdf
   *   9. Salva PDF em disco privado + signed URL 15min
   *  10. INSERT queued → sender → UPDATE sent|failed
   */
  static async sendForMonth(
    orgId: string,
    month?: string | null,
    opts: { actorId?: string | null; force?: boolean; sender?: DocSender; nowMs?: number } = {}
  ): Promise<MonthlyReportDelivery | null> {
    const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
    const normalized = normalizeMonth(month || undefined, nowMs);
    const { enabled, recipientContactId } = readConfig(orgId);

    // (2) Opt-in check — envio automático de PDF financeiro exige decisão consciente
    if (!enabled) {
      const id = insertDelivery({
        orgId, month: normalized, contactId: recipientContactId,
        channelId: null, toIdentifier: null,
        status: "skipped", error: "envio automático desabilitado (opt-in)",
      });
      logAuthEvent(orgId, opts.actorId ?? null, null, "CLINIC_MONTHLY_REPORT_SKIPPED", {
        month: normalized, reason: "disabled",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (3) Recipient obrigatório — sem destinatário, nada a fazer
    if (!recipientContactId) {
      const id = insertDelivery({
        orgId, month: normalized, contactId: null,
        channelId: null, toIdentifier: null,
        status: "skipped", error: "destinatário não configurado",
      });
      logAuthEvent(orgId, opts.actorId ?? null, null, "CLINIC_MONTHLY_REPORT_SKIPPED", {
        month: normalized, reason: "no_recipient",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (5) Dedup por mês
    if (!opts.force) {
      const existing = db.prepare(
        `SELECT * FROM clinical_monthly_report_deliveries
          WHERE organization_id = ? AND month = ? AND status IN ('sent','queued')
          ORDER BY sent_at DESC, rowid DESC LIMIT 1`
      ).get(orgId, normalized) as any;
      if (existing) return hydrate(existing);
    }

    // (6) LGPD comms do destinatário — mesmo sendo owner/sócio, é envio ativo
    if (!LgpdService.hasConsent(orgId, recipientContactId, COMMS_CONSENT)) {
      const id = insertDelivery({
        orgId, month: normalized, contactId: recipientContactId,
        channelId: null, toIdentifier: null,
        status: "skipped", error: "LGPD_COMMS_CONSENT_REQUIRED",
      });
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_SKIPPED", {
        month: normalized, reason: "LGPD_COMMS_CONSENT_REQUIRED",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (4) Recipient existe?
    const contact = db.prepare(
      `SELECT id, name, identifier, channel_id FROM contacts WHERE organization_id = ? AND id = ?`
    ).get(orgId, recipientContactId) as any;
    if (!contact || !contact.identifier) {
      const id = insertDelivery({
        orgId, month: normalized, contactId: recipientContactId,
        channelId: null, toIdentifier: null, status: "failed",
        error: contact ? "Destinatário sem identificador (telefone/WhatsApp)." : "Destinatário não encontrado.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_FAILED", {
        month: normalized, error: contact ? "no_identifier" : "no_contact",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (7) Canal ativo
    const channelId = resolveChannel(orgId, contact.channel_id);
    if (!channelId) {
      const id = insertDelivery({
        orgId, month: normalized, contactId: recipientContactId,
        channelId: null, toIdentifier: contact.identifier,
        status: "failed", error: "Nenhum canal WhatsApp ativo.",
      });
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_FAILED", {
        month: normalized, error: "no_channel",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (8) Renderiza PDF (mesma matemática da Fase 17)
    let pdfBuffer: Buffer;
    let payload: { businessName: string; monthLabel: string };
    try {
      payload = ClinicMonthlyReportService.buildPayload(orgId, normalized, nowMs);
      pdfBuffer = await ClinicMonthlyReportService.renderPdf(orgId, normalized, nowMs);
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      const id = insertDelivery({
        orgId, month: normalized, contactId: recipientContactId,
        channelId, toIdentifier: contact.identifier,
        status: "failed", error: `Falha ao gerar PDF: ${err.slice(0, 200)}`,
      });
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_FAILED", {
        month: normalized, error: "pdf_render_failed",
      });
      return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
    }

    // (9) Salva em disco privado (subpasta por org — isolamento tenant)
    const orgDir = path.join(MONTHLY_REPORT_DIR, orgId);
    try { fs.mkdirSync(orgDir, { recursive: true }); } catch { /* noop */ }
    const pdfBasename = `${randomUUID()}.pdf`;
    const storageKey = safeStorageKey(`${orgId}/${pdfBasename}`);
    const filePath = path.join(MONTHLY_REPORT_DIR, storageKey);
    fs.writeFileSync(filePath, pdfBuffer);

    const fileUrl = this.signedUrl(storageKey, SIGNED_URL_TTL_MS, nowMs);
    const filename = `relatorio-${normalized}.pdf`;
    const caption = renderCaption(payload.businessName, payload.monthLabel);

    // (10) queue → sender → sent|failed
    const id = insertDelivery({
      orgId, month: normalized, contactId: recipientContactId,
      channelId, toIdentifier: contact.identifier, status: "queued",
    });

    const sender: DocSender = opts.sender || MessageProviderService.sendDocument.bind(MessageProviderService);
    try {
      const result = await sender(channelId, contact.identifier, fileUrl, filename, caption);
      const providerMessageId = typeof result === "string" ? result
        : (result?.messages?.[0]?.id || result?.key?.id || result?.id || null);
      db.prepare(
        `UPDATE clinical_monthly_report_deliveries SET status='sent', provider_message_id=? WHERE id=? AND organization_id=?`
      ).run(providerMessageId, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_SENT", {
        month: normalized, deliveryId: id, channelId,
        toIdentifier: maskIdentifier(contact.identifier),
      });
    } catch (e: any) {
      const err = String(e?.message || e).slice(0, 500);
      db.prepare(
        `UPDATE clinical_monthly_report_deliveries SET status='failed', error=? WHERE id=? AND organization_id=?`
      ).run(err, id, orgId);
      logAuthEvent(orgId, opts.actorId ?? null, recipientContactId, "CLINIC_MONTHLY_REPORT_FAILED", {
        month: normalized, deliveryId: id, error: err.slice(0, 200),
      });
    }

    return hydrate(db.prepare(`SELECT * FROM clinical_monthly_report_deliveries WHERE id = ?`).get(id));
  }

  /**
   * Passe do Scheduler — 1 org. Decide se hoje é dia >= `day` configurado e
   * se o mês ANTERIOR ainda não tem entrega `sent|queued`. Se sim, envia.
   *
   * Regra: "envia se estamos no dia configurado OU depois, e o mês passado
   * ainda não foi enviado". Isso protege contra o Scheduler ficar OFF no
   * dia 5 — quando voltar no dia 6, ainda dispara.
   */
  static async dispatchForOrg(
    orgId: string,
    opts: { nowMs?: number; sender?: DocSender } = {}
  ): Promise<{ scanned: number; sent: number; skipped: number; failed: number; noop: number }> {
    const summary = { scanned: 0, sent: 0, skipped: 0, failed: 0, noop: 0 };
    const { enabled, day } = readConfig(orgId);
    if (!enabled) { summary.noop++; return summary; }

    const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
    const now = new Date(nowMs);
    const today = now.getUTCDate();
    if (today < day) { summary.noop++; return summary; }

    // Mês passado (relatório retrospectivo — igual normalizeMonth sem input)
    const targetMonth = normalizeMonth(undefined, nowMs);
    summary.scanned = 1;

    // Já enviado/queued? — dedup barato antes de sequer chamar sendForMonth
    const existing = db.prepare(
      `SELECT id FROM clinical_monthly_report_deliveries
        WHERE organization_id = ? AND month = ? AND status IN ('sent','queued') LIMIT 1`
    ).get(orgId, targetMonth) as any;
    if (existing) { summary.noop++; return summary; }

    try {
      const d = await this.sendForMonth(orgId, targetMonth, { actorId: null, nowMs, sender: opts.sender });
      if (!d) { summary.noop++; return summary; }
      if (d.status === "sent") summary.sent++;
      else if (d.status === "skipped") summary.skipped++;
      else if (d.status === "failed") summary.failed++;
    } catch (e) {
      console.error("[Clínica] monthly report delivery falhou", orgId, e);
      summary.failed++;
    }
    return summary;
  }

  /** Passe do Scheduler pra TODAS as orgs opt-in. */
  static async dispatchAll(opts: { nowMs?: number; sender?: DocSender } = {}): Promise<{ orgs: number; sent: number; skipped: number; failed: number; noop: number }> {
    const summary = { orgs: 0, sent: 0, skipped: 0, failed: 0, noop: 0 };
    const orgs = db.prepare(
      `SELECT organization_id FROM organization_settings
        WHERE clinic_monthly_report_enabled = 1`
    ).all() as any[];
    for (const o of orgs) {
      summary.orgs++;
      try {
        const r = await this.dispatchForOrg(o.organization_id, opts);
        summary.sent += r.sent;
        summary.skipped += r.skipped;
        summary.failed += r.failed;
        summary.noop += r.noop;
      } catch (e) {
        console.error("[Clínica] monthly report dispatch org falhou", o.organization_id, e);
        summary.failed++;
      }
    }
    return summary;
  }
}

export default ClinicMonthlyReportDeliveryService;
