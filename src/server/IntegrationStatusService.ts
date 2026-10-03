/**
 * IntegrationStatusService (ADR-203 F2.6 / PRD Fase 2 §24-§26) — o MODO NORMAL das Integrações e dos Canais:
 * "está conectada? quando sincronizou? o que chega (produtos/vendas/estoque)? alguma loja precisa de atenção?"
 * em linguagem de dono. O MODO AVANÇADO é a tela técnica que já existe (Integrações / Canais e I.A.), preservada
 * e linkada — nada é removido nem duplicado (RN-F2-1/4).
 *
 * COMPÕE read-only: `AlterdataReadinessService.compute` (perfil, token, política por módulo, última run do ledger,
 * recursos por filial) + `AlterdataConnectorService.publicSettings` (ligada? intervalo) + tabela `channels`.
 * Sem tabela/motor/flag nova; sem chamada externa (só o que já foi observado).
 *
 * Regras:
 *  - Honesto (RN-F2-6/7): sem sincronização registrada = "ainda não sincronizou", nunca "conectada"; sincronização
 *    velha (> 4× o intervalo, mín. 1h) vira ATENÇÃO com o carimbo "última sync às HH:MM"; módulo que a política não
 *    suporta nem aparece (não é cadeado).
 *  - Estado vem do ledger/prontidão — nunca inventado: 🟢 ok · 🟡 atenção · 🔴 parada · ⚪ não configurada.
 *  - "N filiais requerem atenção" conta filiais DISTINTAS com recurso falhando na última sincronização.
 *  - Segredos/tokens/IDs técnicos NUNCA saem: só rótulos e frases (o detalhe técnico fica no modo avançado).
 *  - Só gestor (owner/admin): configuração é do gestor; os demais recebem `restricted`. Isolado por org.
 */
import db from "./db.js";
import { AlterdataConnectorService } from "./AlterdataConnectorService.js";
import { AlterdataReadinessService } from "./AlterdataReadinessService.js";

export type IntState = "ok" | "attention" | "down" | "not_configured";
export interface IntFlow { key: string; label: string; state: "ok" | "attention" | "pending"; lastAt: string | null }
export interface IntegrationCard {
  key: string; name: string; state: IntState; stateLabel: string;
  lastSyncAt: string | null; lastSyncHhmm: string | null; stale: boolean;
  flows: IntFlow[];
  attentionCount: number; attentionText: string | null;     // "1 filial requer atenção"
  issues: Array<{ text: string; action: string }>;          // até 3, em linguagem de dono
  advancedViewMode: string;                                 // tela técnica preservada
}
export interface ChannelCard { id: string; name: string; kind: string; state: IntState; stateLabel: string }
export interface IntegrationStatus {
  restricted: boolean;
  summary: string | null;
  integrations: IntegrationCard[];
  channels: ChannelCard[];
  generatedAt: string;
}

const STATE_LABEL: Record<IntState, string> = { ok: "Conectada", attention: "Precisa de atenção", down: "Parada", not_configured: "Não configurada" };
const FLOW_LABEL: Record<string, string> = { supply: "Estoque e compras", price: "Preços", sales: "Vendas", crm: "Clientes", catalog: "Produtos", ecommerce: "Loja virtual", guardian: "Acesso" };
// Linguagem de dono: o código do bloqueio vira frase simples; o texto técnico nunca vai pra tela.
const PLAIN: Record<string, { text: string; action: string }> = {
  PROFILE_MISSING: { text: "A conexão com o ERP ainda não foi configurada.", action: "Abra o modo avançado e preencha os dados da conexão." },
  CREDENTIALS_MISSING: { text: "Falta a senha de acesso ao ERP.", action: "Informe as credenciais no modo avançado." },
  REDE_MISSING: { text: "Falta informar a rede no ERP.", action: "Preencha no modo avançado." },
  FILIAIS_MISSING: { text: "Nenhuma loja foi ligada ao ERP.", action: "Cadastre as filiais no modo avançado." },
  PRICE_TABLE_MISSING: { text: "Falta informar a tabela de preços.", action: "Preencha no modo avançado." },
  TOKEN_MISSING: { text: "A conexão com o ERP ainda não foi autorizada.", action: "Autorize no modo avançado." },
  TOKEN_EXPIRED: { text: "A autorização do ERP venceu.", action: "Renove no modo avançado." },
  PROD_NOT_VALIDATED: { text: "A conexão ainda não foi validada para uso real.", action: "Valide no modo avançado." },
  CRM_LGPD_UNAPPROVED: { text: "A importação de clientes está ligada sem a aprovação de privacidade (LGPD).", action: "Registre a aprovação no modo avançado." },
  BACKUP_ADVISORY: { text: "Faça um backup antes da primeira sincronização.", action: "Veja o modo avançado." },
};
const plainIssue = (b: { code: string; module?: string; action: string }): { text: string; action: string } => {
  if (PLAIN[b.code]) return PLAIN[b.code];
  if (/^MODULE_.+_FAILING$/.test(b.code)) return { text: `A sincronização de ${FLOW_LABEL[String(b.module)] || "um dos fluxos"} está falhando.`, action: "Confira os detalhes no modo avançado." };
  return { text: "Há um ponto de atenção na integração.", action: "Confira os detalhes no modo avançado." };
};
const OK_RES = new Set(["ready", "empty_but_valid", "skipped_by_policy"]);
const KIND: Array<[RegExp, string]> = [[/whats/i, "WhatsApp"], [/insta/i, "Instagram"], [/face|messenger/i, "Facebook"], [/telegram/i, "Telegram"], [/email|mail/i, "E-mail"]];
const kindOf = (provider: string) => KIND.find(([re]) => re.test(provider))?.[1] || "Canal";
const sqlTs = (v: any): number => { const s = String(v || ""); const t = new Date(s.replace(" ", "T") + (s.includes("Z") || /[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")).getTime(); return Number.isFinite(t) ? t : NaN; };
const hhmmSP = (iso: string): string | null => {
  const t = sqlTs(iso); if (!Number.isFinite(t)) return null;
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
  return p;
};

export class IntegrationStatusService {
  static simple(orgId: string, user: any, opts: { now?: Date } = {}): IntegrationStatus {
    const now = opts.now || new Date();
    const role = String(user?.role || "");
    const generatedAt = now.toISOString();
    if (role !== "owner" && role !== "admin") return { restricted: true, summary: null, integrations: [], channels: [], generatedAt };

    const integrations: IntegrationCard[] = [];
    const alterdata = this.alterdata(orgId, now);
    if (alterdata) integrations.push(alterdata);

    const channels: ChannelCard[] = (db.prepare(`SELECT id, name, provider, status FROM channels WHERE organization_id = ? ORDER BY name`).all(orgId) as any[]).map((c) => {
      const st: IntState = c.status === "connected" ? "ok" : "attention";
      return { id: c.id, name: String(c.name), kind: kindOf(String(c.provider || "")), state: st, stateLabel: st === "ok" ? "Conectado" : "Desconectado — precisa reconectar" };
    });

    const bad = integrations.filter((i) => i.state !== "ok" && i.state !== "not_configured").length + channels.filter((c) => c.state !== "ok").length;
    const total = integrations.filter((i) => i.state !== "not_configured").length + channels.length;
    const summary = total === 0 ? null : bad === 0 ? "Tudo conectado." : `${bad} ${bad === 1 ? "ponto precisa" : "pontos precisam"} de atenção.`;
    return { restricted: false, summary, integrations, channels, generatedAt };
  }

  private static alterdata(orgId: string, now: Date): IntegrationCard | null {
    let settings: any;
    try { settings = AlterdataConnectorService.publicSettings(orgId); } catch { return null; }
    if (!settings?.configured) return null;                 // org que não usa o ERP: nem aparece
    const env = settings.environment === "prod" ? "prod" : "homolog";
    const rd = AlterdataReadinessService.compute(orgId, env);
    const base = { key: "alterdata", name: "ERP Alterdata", advancedViewMode: "integrations" };

    if (rd.status === "not_configured" || !rd.configured) {
      return { ...base, state: "not_configured", stateLabel: STATE_LABEL.not_configured, lastSyncAt: null, lastSyncHhmm: null, stale: false, flows: [], attentionCount: 0, attentionText: null, issues: [{ text: "A integração ainda não foi configurada.", action: "Abra o modo avançado e informe a rede, a filial e as credenciais." }] };
    }

    const lastSyncAt = rd.lastRun ? (rd.lastRun.finishedAt || rd.lastRun.startedAt) : null;
    const interval = Number(settings.syncIntervalMinutes) || 15;
    const ageMin = lastSyncAt ? (now.getTime() - sqlTs(lastSyncAt)) / 60000 : null;
    const stale = ageMin !== null && Number.isFinite(ageMin) && ageMin > Math.max(60, 4 * interval);

    const flows: IntFlow[] = rd.modules
      .filter((m) => m.policy !== "unsupported" && m.policy !== "disabled")
      .filter((m) => m.module !== "guardian")                              // acesso/autenticação não é fluxo de negócio
      .filter((m) => m.lastStatus !== null || m.policy === "required")      // "ainda não chegou" só pro que é obrigatório (ruído nos demais)
      .map((m) => ({ key: m.module, label: FLOW_LABEL[m.module] || m.module, lastAt: m.lastRunAt, state: (m.lastStatus === null ? "pending" : m.ok ? "ok" : "attention") as IntFlow["state"] }));

    const badFiliais = new Set(rd.resources.filter((r) => r.filial && !OK_RES.has(r.status)).map((r) => r.filial));
    const attentionCount = badFiliais.size;
    const attentionText = attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? "filial requer" : "filiais requerem"} atenção` : null;

    const blockers = rd.blockers.filter((b) => b.severity === "blocker");
    const issues = blockers.slice(0, 3).map(plainIssue);
    if (stale && issues.length < 3) issues.push({ text: `Não sincroniza desde ${hhmmSP(lastSyncAt as string) ? `as ${hhmmSP(lastSyncAt as string)}` : "há muito tempo"}.`, action: "Confira a conexão no modo avançado." });

    let state: IntState;
    if (!rd.hasCredentials || !rd.hasToken) state = "down";
    else if (!lastSyncAt) state = "attention";
    else if (blockers.length > 0 || stale || attentionCount > 0 || flows.some((f) => f.state === "attention")) state = "attention";
    else state = "ok";
    if (!lastSyncAt && issues.length === 0) issues.push({ text: "Ainda não sincronizou.", action: "Rode a primeira sincronização no modo avançado." });

    return { ...base, state, stateLabel: STATE_LABEL[state], lastSyncAt, lastSyncHhmm: lastSyncAt ? hhmmSP(lastSyncAt) : null, stale, flows, attentionCount, attentionText, issues };
  }
}

export default IntegrationStatusService;
