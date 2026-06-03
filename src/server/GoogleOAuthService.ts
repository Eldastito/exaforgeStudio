import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { JWT_SECRET } from "./config/secret.js";

// Integração Google (server-side, com acesso offline). Diferente do login do
// Firebase (que vive só no navegador), aqui guardamos um refresh_token por
// organização para a IA/servidor usar Drive, Calendar, Gmail e Sheets mesmo com
// o dono offline. Usa as APIs REST do Google via fetch (sem dependência nova).

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const REDIRECT_URI = `${APP_URL}/api/integrations/google/callback`;

const SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

const STATE_TTL_MS = 10 * 60 * 1000;

export class GoogleOAuthService {
  static isConfigured(): boolean {
    return !!(CLIENT_ID && CLIENT_SECRET && APP_URL);
  }

  // ---- state assinado (anti-CSRF, igual ao Instagram) ----
  private static signState(orgId: string): string {
    const payload = Buffer.from(JSON.stringify({ orgId, t: Date.now() })).toString("base64url");
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }
  private static verifyState(state: string): string | null {
    if (!state || !state.includes(".")) return null;
    const [payload, sig] = state.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const { orgId, t } = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!orgId || typeof t !== "number" || Date.now() - t > STATE_TTL_MS) return null;
      return String(orgId);
    } catch { return null; }
  }

  static authUrl(orgId: string): string {
    const p = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      access_type: "offline",
      prompt: "consent", // garante o refresh_token mesmo em reconexões
      include_granted_scopes: "true",
      scope: SCOPES,
      state: this.signState(orgId),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  }

  // Troca o code do callback por tokens e salva a conexão. Retorna o orgId.
  static async handleCallback(code: string, state: string): Promise<string | null> {
    const orgId = this.verifyState(state);
    if (!orgId || !code) return null;
    try {
      const tokRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
        }),
      });
      const tok: any = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tok.access_token) {
        console.error("[Google OAuth] Falha no token:", tok);
        return null;
      }
      // Perfil (e-mail/nome) para exibir.
      let email = "", name = "";
      try {
        const me: any = await (await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
          headers: { Authorization: `Bearer ${tok.access_token}` },
        })).json();
        email = me?.email || ""; name = me?.name || "";
      } catch { /* ok */ }

      const expiresAt = new Date(Date.now() + (Number(tok.expires_in || 3600) * 1000)).toISOString();
      // Upsert (uma conexão Google por org). Preserva o refresh_token se o Google
      // não reenviar (raro, porque usamos prompt=consent).
      const existing = db.prepare("SELECT refresh_token FROM oauth_connections WHERE organization_id = ? AND provider = 'google'").get(orgId) as any;
      const refresh = tok.refresh_token || existing?.refresh_token || null;
      db.prepare("DELETE FROM oauth_connections WHERE organization_id = ? AND provider = 'google'").run(orgId);
      db.prepare(
        `INSERT INTO oauth_connections (id, organization_id, provider, access_token, refresh_token, scopes, expires_at, account_email, account_name)
         VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), orgId, tok.access_token, refresh, SCOPES, expiresAt, email, name);
      return orgId;
    } catch (e) {
      console.error("[Google OAuth] callback erro:", e);
      return null;
    }
  }

  static getConnection(orgId: string): any {
    return db.prepare("SELECT * FROM oauth_connections WHERE organization_id = ? AND provider = 'google'").get(orgId) as any || null;
  }

  static status(orgId: string) {
    const c = this.getConnection(orgId);
    return {
      configured: this.isConfigured(),
      connected: !!c,
      email: c?.account_email || "",
      name: c?.account_name || "",
    };
  }

  static disconnect(orgId: string) {
    db.prepare("DELETE FROM oauth_connections WHERE organization_id = ? AND provider = 'google'").run(orgId);
  }

  // Retorna um access_token válido (renova com o refresh_token se expirado).
  static async getAccessToken(orgId: string): Promise<string | null> {
    const c = this.getConnection(orgId);
    if (!c) return null;
    const notExpired = c.expires_at && new Date(c.expires_at).getTime() > Date.now() + 60_000;
    if (notExpired && c.access_token) return c.access_token;
    if (!c.refresh_token) return c.access_token || null; // sem refresh: usa enquanto valer
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          refresh_token: c.refresh_token, grant_type: "refresh_token",
        }),
      });
      const tok: any = await res.json().catch(() => ({}));
      if (!res.ok || !tok.access_token) { console.error("[Google OAuth] refresh falhou:", tok); return null; }
      const expiresAt = new Date(Date.now() + (Number(tok.expires_in || 3600) * 1000)).toISOString();
      db.prepare("UPDATE oauth_connections SET access_token = ?, expires_at = ? WHERE id = ?").run(tok.access_token, expiresAt, c.id);
      return tok.access_token;
    } catch (e) {
      console.error("[Google OAuth] refresh erro:", e);
      return null;
    }
  }

  // ---- Google Drive ----
  // Faz upload de um arquivo (multipart) para o Drive do dono. Retorna link.
  static async driveUpload(orgId: string, name: string, mimeType: string, content: Buffer): Promise<{ id: string; link: string } | { error: string }> {
    const token = await this.getAccessToken(orgId);
    if (!token) return { error: "Conta Google não conectada (ou token expirado)." };
    const boundary = "exaforge_" + uuidv4().replace(/-/g, "");
    const meta = JSON.stringify({ name });
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const body = Buffer.concat([Buffer.from(pre, "utf-8"), content, Buffer.from(post, "utf-8")]);
    try {
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) { console.error("[Google Drive] upload falhou:", data); return { error: data?.error?.message || "Falha ao enviar ao Drive." }; }
      return { id: data.id, link: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
    } catch (e: any) {
      console.error("[Google Drive] erro:", e);
      return { error: "Erro de rede ao enviar ao Drive." };
    }
  }

  // ---- Google Calendar ----
  static async calendarCreateEvent(orgId: string, ev: { summary: string; description?: string; start: string; end: string }): Promise<{ id: string; link: string } | { error: string }> {
    const token = await this.getAccessToken(orgId);
    if (!token) return { error: "Conta Google não conectada." };
    const body = {
      summary: ev.summary || "Agendamento",
      description: ev.description || "",
      start: { dateTime: ev.start, timeZone: "America/Sao_Paulo" },
      end: { dateTime: ev.end, timeZone: "America/Sao_Paulo" },
    };
    try {
      const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) { console.error("[Google Calendar] criar evento falhou:", data); return { error: data?.error?.message || "Falha ao criar evento." }; }
      return { id: data.id, link: data.htmlLink || "" };
    } catch (e: any) {
      console.error("[Google Calendar] erro:", e);
      return { error: "Erro de rede ao criar evento." };
    }
  }

  static async calendarDeleteEvent(orgId: string, eventId: string): Promise<boolean> {
    const token = await this.getAccessToken(orgId);
    if (!token || !eventId) return false;
    try {
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      return res.ok || res.status === 410; // 410 = já removido
    } catch { return false; }
  }

  // Cria o evento no Google Calendar para um agendamento (best-effort) e guarda
  // o id/link no próprio agendamento. Só faz algo se a conta Google estiver ligada.
  static async syncAppointment(orgId: string, appointmentId: string): Promise<void> {
    try {
      if (!this.getConnection(orgId)) return;
      const a = db.prepare("SELECT * FROM appointments WHERE id = ? AND organization_id = ?").get(appointmentId, orgId) as any;
      if (!a || !a.scheduled_start || a.google_event_id) return;
      const start = toRfc3339(a.scheduled_start);
      const end = a.scheduled_end ? toRfc3339(a.scheduled_end) : addOneHour(start);
      const r = await this.calendarCreateEvent(orgId, { summary: a.title || "Agendamento", description: a.description || "", start, end });
      if (r && "id" in r) {
        db.prepare("UPDATE appointments SET google_event_id = ?, google_event_link = ? WHERE id = ?").run(r.id, (r as any).link || "", appointmentId);
      }
    } catch (e) { console.error("[Google Calendar] sync appointment:", e); }
  }
}

// "2026-06-10 14:00:00" / "2026-06-10T14:00:00Z" -> "2026-06-10T14:00:00" (hora de parede)
function toRfc3339(v: any): string {
  return String(v || "").trim().replace(" ", "T").replace(/Z$/, "").slice(0, 19);
}
// Soma 1h tratando a string como hora de parede (o timeZone vai junto no evento).
function addOneHour(rfc: string): string {
  const [date, time = "00:00:00"] = rfc.split("T");
  const [Y, Mo, D] = date.split("-").map((n) => parseInt(n, 10));
  const [h, m, s] = time.split(":").map((n) => parseInt(n, 10) || 0);
  const dt = new Date(Date.UTC(Y, (Mo || 1) - 1, D || 1, (h || 0) + 1, m, s));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}
