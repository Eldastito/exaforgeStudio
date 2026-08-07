/**
 * ADR-154 F8.7 — adapter de TELEFONIA (voz) da plataforma.
 *
 * Nasce pro caso-bandeira dos Protocolos do FalaTu (a "chamada de resgate"),
 * mas é deliberadamente genérico: `call(to, message)` liga pro número e fala
 * a mensagem. O provider fica atrás desta fachada — a ADR deixou a escolha
 * pra fatia, e a fatia escolheu **Twilio** como MVP (API de voz REST mais
 * simples: um POST cria a chamada com o TwiML inline). Trocar de provider
 * (Zenvia etc.) é reimplementar `call()` sem tocar nenhum consumidor.
 *
 * Configuração 100% por env (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 * TWILIO_FROM_NUMBER) — sem env, `configured()` é false e quem consome
 * explica ao usuário (nada de meio-funcionar). Nenhum segredo em DB.
 *
 * IMPORTANTE (guardrail F8.7): este service NÃO decide destino — quem chama
 * passa o número. A garantia de "só liga pro número verificado do próprio
 * usuário" vive no FalaTuProtocolService, que é o único caminho até aqui.
 */

export type VoiceCall = (toE164: string, message: string) => Promise<{ callId: string | null }>;

const esc = (s: string) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export class TelephonyService {
  static configured(): boolean {
    return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  }

  /** Liga pro número e FALA a mensagem (pt-BR, 2x). Lança em falha — quem
   *  consome decide o que é best-effort. */
  static async call(toE164: string, message: string): Promise<{ callId: string | null }> {
    if (!this.configured()) throw new Error("Telefonia não configurada (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER).");
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN!}`).toString("base64");
    const twiml = `<Response><Say language="pt-BR" loop="2">${esc(message)}</Say></Response>`;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: toE164, From: process.env.TWILIO_FROM_NUMBER!, Twiml: twiml }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${body?.message || "falha ao criar chamada"}`);
    return { callId: body?.sid || null };
  }
}

export default TelephonyService;
