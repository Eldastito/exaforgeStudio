/**
 * ProfessionalGoogleService — ADR-180 F6.1: Google Calendar POR PROFISSIONAL
 * (Agenda Federada).
 *
 * O profissional tem UMA agenda Google que TODAS as clínicas respeitam — a conexão é
 * GLOBAL, chaveada por `professional_id` (sem organization_id), espelhando a identidade
 * global de `ProfessionalService` (§90: o calendário é da identidade do ecossistema, não
 * de uma clínica). Reusa a mecânica OAuth/HTTP do `GoogleOAuthService` (mesmas rotas do
 * Google, `EncryptionService` pra cifrar tokens — convenção nº 4/6), mas:
 *   • escopo CALENDAR-ONLY (least-privilege — sem Drive/Sheets/Gmail);
 *   • `state` assinado carrega professionalId + orgId (o callback é público);
 *   • token store per-profissional (`professional_google_connections`).
 *
 * Capacidades: `busyIntervals` (freeBusy ESTRUTURADO → {start,end} ms, consumido pela
 * disponibilidade na F6.2) e `createEvent`/`deleteEvent` (empurra o atendimento federado
 * pra agenda do profissional na F6.3). `fetchFn` é INJETÁVEL (testes determinísticos, sem
 * rede — mesmo padrão dos deps injetáveis do repo). Nunca lança pro caller (best-effort).
 */
import crypto from "crypto";
import { randomUUID } from "crypto";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";
import { EncryptionService } from "./EncryptionService.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const REDIRECT_URI = `${APP_URL}/api/integrations/google/professional-callback`;

// Least-privilege: só calendário (events p/ criar, freebusy p/ ler ocupação) + e-mail
// pra rotular a conta. NADA de Drive/Sheets/Gmail (diferente do fluxo da org).
const SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;

export interface GoogleHttpDeps { fetchFn?: typeof fetch }
export interface BusyInterval { start: number; end: number }   // epoch ms

export class ProfessionalGoogleService {
  /** Injeção pra teste (sem rede). Em produção usa o fetch global. */
  static deps: GoogleHttpDeps = {};
  private static http(): typeof fetch { return (this.deps.fetchFn || (globalThis.fetch as any)) as typeof fetch; }

  static isConfigured(): boolean { return !!(CLIENT_ID && CLIENT_SECRET && APP_URL); }

  // ---- state assinado (anti-CSRF); carrega professionalId + orgId (auditoria/gate) ----
  private static signState(professionalId: string, orgId: string): string {
    const payload = Buffer.from(JSON.stringify({ pid: professionalId, orgId, t: Date.now() })).toString("base64url");
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }
  private static verifyState(state: string): { professionalId: string; orgId: string } | null {
    if (!state || !state.includes(".")) return null;
    const [payload, sig] = state.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const { pid, orgId, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!pid || !orgId || typeof t !== "number" || Date.now() - t > STATE_TTL_MS) return null;
      return { professionalId: String(pid), orgId: String(orgId) };
    } catch { return null; }
  }

  /** URL de consentimento pro profissional autorizar a própria agenda. */
  static authUrl(professionalId: string, orgId: string): string {
    const p = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      scope: SCOPES, state: this.signState(professionalId, orgId),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  }

  /** Troca o code do callback por tokens e grava a conexão do PROFISSIONAL. Retorna o pid. */
  static async handleCallback(code: string, state: string): Promise<string | null> {
    const st = this.verifyState(state);
    if (!st || !code) return null;
    try {
      const tokRes = await this.http()("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
      });
      const tok: any = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tok.access_token) { console.error("[Prof Google] token falhou:", tok); return null; }
      let email = "", name = "";
      try {
        const me: any = await (await this.http()("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
        email = me?.email || ""; name = me?.name || "";
      } catch { /* ok */ }
      this.persist(st.professionalId, {
        accessToken: tok.access_token,
        refreshToken: tok.refresh_token || null,
        expiresInSec: Number(tok.expires_in || 3600),
        email, name,
      }, st.orgId);
      return st.professionalId;
    } catch (e) { console.error("[Prof Google] callback erro:", e); return null; }
  }

  /** Grava/atualiza a conexão (preserva refresh_token se o Google não reenviar). */
  private static persist(professionalId: string, t: { accessToken: string; refreshToken: string | null; expiresInSec: number; email: string; name: string }, orgId: string): void {
    const existing = db.prepare("SELECT refresh_token FROM professional_google_connections WHERE professional_id = ? AND provider = 'google'").get(professionalId) as any;
    const refresh = t.refreshToken || EncryptionService.decrypt(existing?.refresh_token) || null;
    const expiresAt = new Date(Date.now() + t.expiresInSec * 1000).toISOString();
    db.prepare("DELETE FROM professional_google_connections WHERE professional_id = ? AND provider = 'google'").run(professionalId);
    db.prepare(
      `INSERT INTO professional_google_connections (id, professional_id, provider, access_token, refresh_token, scopes, expires_at, account_email, account_name, connected_by_org)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), professionalId, EncryptionService.encrypt(t.accessToken), EncryptionService.encrypt(refresh), SCOPES, expiresAt, t.email, t.name, orgId || null);
  }

  static getConnection(professionalId: string): any {
    const c = db.prepare("SELECT * FROM professional_google_connections WHERE professional_id = ? AND provider = 'google'").get(String(professionalId || "")) as any || null;
    if (c) {
      if (c.access_token) c.access_token = EncryptionService.decrypt(c.access_token);
      if (c.refresh_token) c.refresh_token = EncryptionService.decrypt(c.refresh_token);
    }
    return c;
  }

  /** Estado REDIGIDO (nunca devolve token) — pra UI/status. */
  static status(professionalId: string) {
    const c = this.getConnection(professionalId);
    return { configured: this.isConfigured(), connected: !!c, email: c?.account_email || "", name: c?.account_name || "" };
  }

  static disconnect(professionalId: string): void {
    db.prepare("DELETE FROM professional_google_connections WHERE professional_id = ? AND provider = 'google'").run(String(professionalId || ""));
  }

  /** access_token válido (renova com o refresh_token se expirado). null se não conectado. */
  static async getAccessToken(professionalId: string): Promise<string | null> {
    const c = this.getConnection(professionalId);
    if (!c) return null;
    const notExpired = c.expires_at && new Date(c.expires_at).getTime() > Date.now() + 60_000;
    if (notExpired && c.access_token) return c.access_token;
    if (!c.refresh_token) return c.access_token || null;
    try {
      const res = await this.http()("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: c.refresh_token, grant_type: "refresh_token" }),
      });
      const tok: any = await res.json().catch(() => ({}));
      if (!res.ok || !tok.access_token) { console.error("[Prof Google] refresh falhou:", tok); return null; }
      const expiresAt = new Date(Date.now() + (Number(tok.expires_in || 3600) * 1000)).toISOString();
      db.prepare("UPDATE professional_google_connections SET access_token = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(EncryptionService.encrypt(tok.access_token), expiresAt, c.id);
      return tok.access_token;
    } catch (e) { console.error("[Prof Google] refresh erro:", e); return null; }
  }

  /**
   * freeBusy ESTRUTURADO da agenda do profissional (intervalos ocupados em ms). Vazio se
   * não conectado (0-regressão) ou em qualquer falha (best-effort). Consumido pela
   * disponibilidade (F6.2) pra não OFERECER vaga em cima de compromisso do Google.
   */
  static async busyIntervals(professionalId: string, opts: { timeMinISO: string; timeMaxISO: string }): Promise<BusyInterval[]> {
    try {
      const token = await this.getAccessToken(professionalId);
      if (!token) return [];
      const res = await this.http()("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ timeMin: opts.timeMinISO, timeMax: opts.timeMaxISO, timeZone: "America/Sao_Paulo", items: [{ id: "primary" }] }),
      });
      const data: any = await res.json().catch(() => ({}));
      const busy: { start: string; end: string }[] = data?.calendars?.primary?.busy || [];
      const out: BusyInterval[] = [];
      for (const b of busy) {
        const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
        if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.push({ start: s, end: e });
      }
      return out;
    } catch { return []; }
  }

  /** Cria evento na agenda do profissional (best-effort). Retorna o id ou null. */
  static async createEvent(professionalId: string, ev: { summary: string; description?: string; startISO: string; endISO: string }): Promise<string | null> {
    try {
      const token = await this.getAccessToken(professionalId);
      if (!token) return null;
      const body = {
        summary: ev.summary || "Atendimento", description: ev.description || "",
        start: { dateTime: ev.startISO, timeZone: "America/Sao_Paulo" },
        end: { dateTime: ev.endISO, timeZone: "America/Sao_Paulo" },
      };
      const res = await this.http()("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) { console.error("[Prof Google] criar evento falhou:", data); return null; }
      return data.id as string;
    } catch (e) { console.error("[Prof Google] createEvent erro:", e); return null; }
  }

  /** Remove um evento da agenda do profissional (best-effort). 410 = já removido. */
  static async deleteEvent(professionalId: string, eventId: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken(professionalId);
      if (!token || !eventId) return false;
      const res = await this.http()(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok || res.status === 410;
    } catch { return false; }
  }
}

export default ProfessionalGoogleService;
