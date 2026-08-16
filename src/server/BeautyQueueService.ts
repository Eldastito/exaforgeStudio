/**
 * BeautyQueueService (ADR-169 F37 / BEAUTY-038) — Fila virtual por QR code.
 *
 * Para salões SEM TV (ou com público discreto/seletivo), o aviso "é a sua
 * vez" não vai num monitor coletivo: vai pro CELULAR do próprio cliente. A
 * recepção mostra um QR na tela do painel; o cliente aponta a câmera, o
 * navegador dele abre uma página que mostra a posição na fila e vira
 * "É A SUA VEZ!" no momento em que a recepção encerra o atendimento anterior
 * e o chama — exatamente o mesmo gatilho do Painel de TV (F36), só que
 * pessoal e privado.
 *
 * Sem login do cliente. O acesso é por URL ASSINADA HMAC — reusa o
 * `fileSigning` canônico (convenção nº 4), escopo próprio `beauty_queue_v1`,
 * chave `queue/{appointmentId}`. TTL longo (12h) pra cobrir um dia inteiro de
 * salão; a assinatura expira sozinha (a fila é do dia). NENHUMA tabela nova:
 * a "fila" é DERIVADA da agenda canônica `appointments` (§42), igual ao
 * painel da recepção (F34) e à TV (F35/F36).
 *
 * Semântica de "sua vez" (alinhada ao `highlight` da TV, mas POR PROFISSIONAL
 * pra não avisar cedo demais quando há várias cadeiras):
 *  - se o MEU status já é `in_progress` → estou sendo atendida agora;
 *  - senão, é a minha vez quando o MEU profissional NÃO está atendendo
 *    ninguém (nenhum `in_progress` dele) E eu sou o 1º da fila de espera dele;
 *  - se o agendamento não tem profissional (walk-in), cai pra fila do salão
 *    inteiro.
 *
 * Privacidade (LGPD, minimização): a página devolve só o PRIMEIRO NOME do
 * próprio cliente (é a página DELE) + nome do profissional (staff) + serviço +
 * horário + posição. NUNCA o nome de outros clientes da fila — só a CONTAGEM
 * de quantos estão na frente.
 *
 * Guardrails:
 *  - RN-BS-07 (isolamento): `sign` exige que o appointment seja da própria org;
 *    `status` opera sobre a org DO PRÓPRIO appointment (a assinatura prova a
 *    posse do link). Toda query filtra `organization_id`.
 *  - RN-BS-08 (dinheiro role-gated): a página pública NÃO devolve R$.
 *  - Horário em America/Sao_Paulo (mesma convenção do AppointmentService).
 */
import db from "./db.js";
import { AppointmentService } from "./AppointmentService.js";
import { signKey, verifyKey } from "./fileSigning.js";

const SCOPE = "beauty_queue";
const KEY_TTL_MS = 12 * 60 * 60 * 1000; // 12h — cobre um dia de salão

function keyFor(appointmentId: string): string {
  // `queue/{id}` satisfaz o `safeStorageKey` (2 segmentos [A-Za-z0-9._-]).
  return `queue/${appointmentId}`;
}

/** "Emily Souza" → "Emily" (primeiro nome; a página é do próprio cliente). */
function firstName(full: string | null | undefined): string {
  const p = String(full || "").trim().split(/\s+/).filter(Boolean);
  return p[0] || "Cliente";
}

type ApptRow = {
  id: string; organization_id: string; contact_id: string | null;
  professional_id: string | null; professional_name_snapshot: string | null;
  scheduled_start: string | null; status: string; title: string | null;
  client_name?: string | null; prof_name?: string | null;
};

export type QueueState =
  | "your_turn"    // é a sua vez (chamando)
  | "serving"      // sendo atendida agora
  | "waiting"      // na fila
  | "done"         // atendimento concluído
  | "no_show"      // marcado como não compareceu
  | "cancelled"    // cancelado
  | "not_found";   // agendamento inexistente/expirado

export interface QueueStatus {
  found: boolean;
  state: QueueState;
  clientName: string;              // primeiro nome do PRÓPRIO cliente
  serviceName: string | null;
  professionalName: string | null;
  startTime: string | null;        // "HH:MM" local
  position: number | null;         // 1 = próximo; null quando não faz sentido
  peopleAhead: number | null;      // quantos na frente ainda esperando
  message: string;                 // texto pronto pt-BR pra tela do celular
  date: string;                    // "YYYY-MM-DD" do agendamento
}

export class BeautyQueueService {
  // ── Assinatura do link (uso interno da recepção, autenticado) ────────────
  /**
   * Gera `{ exp, sig }` pra montar o link público da fila de um agendamento.
   * Exige que o agendamento seja da org (isolamento) e não esteja cancelado.
   */
  static sign(orgId: string, appointmentId: string): { ok: true; exp: number; sig: string; key: string } | { ok: false; error: string } {
    const row = db.prepare(
      `SELECT id, status FROM appointments WHERE id = ? AND organization_id = ?`,
    ).get(appointmentId, orgId) as any;
    if (!row) return { ok: false, error: "Agendamento não encontrado." };
    if (row.status === "cancelled") return { ok: false, error: "Agendamento cancelado." };
    const { exp, sig } = signKey(SCOPE, keyFor(appointmentId), KEY_TTL_MS);
    return { ok: true, exp, sig, key: appointmentId };
  }

  // ── Janela do dia (BRT) a partir do horário do agendamento ──────────────
  private static dayWindow(startMs: number | null): { startMs: number; endMs: number; dateISO: string } {
    const base = startMs != null ? new Date(startMs - 3 * 3600_000) : new Date(Date.now() - 3 * 3600_000);
    const y = base.getUTCFullYear(), mo = base.getUTCMonth(), da = base.getUTCDate();
    const winStart = Date.UTC(y, mo, da, 3, 0, 0, 0); // 00:00 BRT = 03:00 UTC
    return {
      startMs: winStart,
      endMs: winStart + 24 * 3600_000,
      dateISO: `${y.toString().padStart(4, "0")}-${(mo + 1).toString().padStart(2, "0")}-${da.toString().padStart(2, "0")}`,
    };
  }

  private static hhmm(ms: number | null): string | null {
    if (ms == null) return null;
    const d = new Date(ms - 3 * 3600_000);
    return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
  }

  // ── Status público (assinatura prova a posse; sem sessão) ────────────────
  /**
   * Verifica a assinatura e devolve o estado da fila pro celular do cliente.
   * A org NÃO vem do auth — vem do próprio agendamento (a assinatura HMAC
   * prova que quem tem o link recebeu o QR da recepção daquele agendamento).
   */
  static status(appointmentId: string, exp: string | number, sig: string): QueueStatus {
    const notFound: QueueStatus = {
      found: false, state: "not_found", clientName: "Cliente", serviceName: null,
      professionalName: null, startTime: null, position: null, peopleAhead: null,
      message: "Não encontramos esse atendimento. Fale com a recepção.", date: "",
    };
    if (!verifyKey(SCOPE, keyFor(appointmentId), exp, sig)) return notFound;

    const me = db.prepare(
      `SELECT a.id, a.organization_id, a.contact_id, a.professional_id,
              a.professional_name_snapshot, a.scheduled_start, a.status, a.title,
              ct.name AS client_name, p.name AS prof_name
         FROM appointments a
         LEFT JOIN contacts ct ON ct.id = a.contact_id AND ct.organization_id = a.organization_id
         LEFT JOIN clinic_professionals p ON p.id = a.professional_id AND p.organization_id = a.organization_id
        WHERE a.id = ?`,
    ).get(appointmentId) as ApptRow | undefined;
    if (!me) return notFound;

    const orgId = me.organization_id;
    const myStartMs = AppointmentService.ms(me.scheduled_start);
    const win = this.dayWindow(myStartMs);
    const clientName = firstName(me.client_name);
    const professionalName = me.professional_name_snapshot || me.prof_name || null;
    const serviceName = me.title || null;
    const startTime = this.hhmm(myStartMs);
    const baseOut = { found: true, clientName, serviceName, professionalName, startTime, date: win.dateISO };

    // Estados terminais — não dependem da fila.
    if (me.status === "cancelled")
      return { ...baseOut, state: "cancelled", position: null, peopleAhead: null, message: "Este atendimento foi cancelado. Fale com a recepção." };
    if (me.status === "completed")
      return { ...baseOut, state: "done", position: null, peopleAhead: null, message: "Atendimento concluído. Obrigado pela visita! 💜" };
    if (me.status === "no_show")
      return { ...baseOut, state: "no_show", position: null, peopleAhead: null, message: "Perdemos você hoje. Fale com a recepção pra reagendar." };

    // Fila do dia da org — POR PROFISSIONAL (fallback salão inteiro se sem prof).
    const startIso = new Date(win.startMs).toISOString();
    const endIso = new Date(win.endMs).toISOString();
    const scoped = me.professional_id
      ? { clause: "AND a.professional_id = ?", args: [me.professional_id] as any[] }
      : { clause: "", args: [] as any[] };
    const rows = db.prepare(
      `SELECT a.id, a.status, a.scheduled_start
         FROM appointments a
        WHERE a.organization_id = ?
          AND a.status != 'cancelled'
          AND a.scheduled_start >= ? AND a.scheduled_start < ?
          ${scoped.clause}
        ORDER BY a.scheduled_start ASC, a.id ASC`,
    ).all(orgId, startIso, endIso, ...scoped.args) as Array<{ id: string; status: string; scheduled_start: string | null }>;

    const servingCount = rows.filter((r) => r.status === "in_progress").length;
    const waiting = rows.filter((r) => r.status === "pending" || r.status === "confirmed");
    const myWaitIdx = waiting.findIndex((r) => r.id === me.id);

    // Já em atendimento → "sendo atendida".
    if (me.status === "in_progress") {
      return { ...baseOut, state: "serving", position: null, peopleAhead: null,
        message: professionalName ? `Você está sendo atendida por ${professionalName}. 💜` : "Você está sendo atendida. 💜" };
    }

    // É a vez: profissional livre (ninguém em atendimento na fila dele) e eu sou o 1º da espera.
    const isFront = myWaitIdx === 0;
    if (servingCount === 0 && isFront) {
      return { ...baseOut, state: "your_turn", position: 1, peopleAhead: 0,
        message: professionalName ? `É a sua vez! Dirija-se à recepção — ${professionalName} vai te atender.` : "É a sua vez! Dirija-se à recepção." };
    }

    // Ainda esperando.
    const peopleAhead = myWaitIdx < 0 ? waiting.length : myWaitIdx;
    const position = peopleAhead + 1;
    const aheadMsg = peopleAhead === 0
      ? "Você é o próximo — só falta o atendimento em andamento terminar."
      : peopleAhead === 1 ? "Falta 1 pessoa na sua frente."
      : `Faltam ${peopleAhead} pessoas na sua frente.`;
    return { ...baseOut, state: "waiting", position, peopleAhead, message: aheadMsg };
  }
}

export default BeautyQueueService;
