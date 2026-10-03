/**
 * UxPilotReportService (ADR-203 F2.9 / PRD Fase 2 §36) — "como a equipe está usando o menu simplificado?", em linguagem de gestor.
 * COMPÕE read-only a telemetria que já existe (`ux_telemetry_events`, opt-in LGPD) — sem tabela, sem coleta nova além do que o
 * `UxTelemetryService` já limita (id de tela, nunca conteúdo). Serve para decidir SE o menu novo ajuda, antes de qualquer retirada.
 *
 * Honestidade (RN-F2-6/7/10):
 *  - telemetria DESLIGADA = `state:"disabled"` e NENHUM número (não finge zero); sem eventos na janela = `no_data`; poucos eventos =
 *    `low_sample` (mostra, mas avisa que não prova nada); só `ok` quando há amostra mínima (≥30 aberturas de tela e ≥2 pessoas).
 *  - mede ABERTURAS e cliques, NÃO valor: abrir muito uma tela não prova que ela ajudou (o painel diz isso).
 *  - agregados por org e por tela; só gestor (visão completa); nunca quem fez o quê (só nº de pessoas distintas).
 *  - ADVISÓRIO: nada é removido ou promovido sozinho; a retirada de legado segue no `LegacyReductionService` (humano decide, §112).
 */
import db from "./db.js";
import { UxTelemetryService } from "./UxTelemetryService.js";
import { NavigationManifestService } from "./NavigationManifestService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

export const MIN_VIEWS = 30, MIN_USERS = 2;
const LABEL: Record<string, string> = { hoje: "Hoje", executando: "Executando", resultados: "Resultados", empresa: "Empresa", falatu: "FalaTu", dashboard: "Atendimento Digital", saude: "Central de Saúde", insights: "Insights", diretor: "Diretor IA", tarefas: "Tarefas", missoes: "Missões", retailops: "Operação da Rede", settings: "Configurações", kanban: "Atendimento", caixa: "Caixa", contacts: "Contatos", reports: "Relatórios" };
const labelOf = (k: string) => LABEL[k] || k;

export type PilotState = "disabled" | "no_data" | "low_sample" | "ok";
export interface PilotReport {
  restricted: boolean;
  windowDays: number;
  state: PilotState;
  telemetryEnabled: boolean;
  simplifiedNavEnabled: boolean;
  sample: { views: number; users: number; sessions: number; minViews: number; minUsers: number };
  topScreens: Array<{ screen: string; label: string; views: number }>;
  entry: { primary: number; explorar: number; explorarSharePct: number | null };   // como chegaram às telas (cliques de navegação)
  hoje: { opens: number; actionClicks: number; actionRatePct: number | null };
  falatuQuestions: { total: number; withStore: number; followUps: number };
  searchMisses: number;
  notes: string[];
  generatedAt: string;
}

export class UxPilotReportService {
  static build(orgId: string, user: any, opts: { days?: number; now?: Date } = {}): PilotReport {
    const days = Math.max(1, Math.min(90, Number(opts.days) || 14));
    const generatedAt = (opts.now || new Date()).toISOString();
    const enabled = UxTelemetryService.enabled(orgId);
    const base = { windowDays: days, telemetryEnabled: enabled, simplifiedNavEnabled: NavigationManifestService.isSimplified(orgId), generatedAt };
    const empty = { sample: { views: 0, users: 0, sessions: 0, minViews: MIN_VIEWS, minUsers: MIN_USERS }, topScreens: [], entry: { primary: 0, explorar: 0, explorarSharePct: null }, hoje: { opens: 0, actionClicks: 0, actionRatePct: null }, falatuQuestions: { total: 0, withStore: 0, followUps: 0 }, searchMisses: 0 };
    if (!ContextProjectionService.hasFullBusinessVisibility(orgId, user)) return { ...base, ...empty, restricted: true, state: "disabled", notes: ["O uso do menu é do gestor."] };
    if (!enabled) return { ...base, ...empty, restricted: false, state: "disabled", notes: ["A coleta de uso está desligada (consentimento). Ligue em Configurações → Módulos para medir o piloto."] };

    const rows = db.prepare(`SELECT event_type, surface, module_key, session_id, user_id FROM ux_telemetry_events WHERE organization_id = ? AND datetime(created_at) >= datetime('now', ?)`).all(orgId, `-${days} day`) as any[];
    const views = rows.filter((r) => r.event_type === "view_opened");
    const users = new Set(rows.map((r) => r.user_id).filter(Boolean));
    const sessions = new Set(rows.map((r) => r.session_id).filter(Boolean));

    const byScreen = new Map<string, number>();
    for (const v of views) if (v.surface) byScreen.set(v.surface, (byScreen.get(v.surface) || 0) + 1);
    const topScreens = [...byScreen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([screen, n]) => ({ screen, label: labelOf(screen), views: n }));

    const actions = rows.filter((r) => r.event_type === "action_clicked");
    const primary = actions.filter((r) => r.surface === "nav_primario").length, explorar = actions.filter((r) => r.surface === "nav_explorar").length;
    const hojeOpens = byScreen.get("hoje") || 0, hojeActs = actions.filter((r) => r.surface === "hoje_acao").length;
    const fq = actions.filter((r) => r.surface === "falatu_pergunta");

    const state: PilotState = views.length === 0 ? "no_data" : views.length < MIN_VIEWS || users.size < MIN_USERS ? "low_sample" : "ok";
    const notes: string[] = ["Mede aberturas e cliques — não mede se ajudou. Abrir muito uma tela não prova valor; use junto com a conversa com a equipe."];
    if (state === "no_data") notes.unshift(base.simplifiedNavEnabled ? "Ainda sem uso registrado na janela." : "O menu simplificado está desligado nesta empresa.");
    if (state === "low_sample") notes.unshift(`Amostra pequena (${views.length} aberturas, ${users.size} ${users.size === 1 ? "pessoa" : "pessoas"}; mínimo ${MIN_VIEWS} aberturas e ${MIN_USERS} pessoas) — não conclua nada ainda.`);
    if (!base.simplifiedNavEnabled && state !== "no_data") notes.push("O menu simplificado está desligado: os números abaixo são do menu completo.");
    const searchMisses = rows.filter((r) => r.event_type === "search_no_result").length;
    if (searchMisses > 0) notes.push("Há buscas no Explorar sem resultado — falta atalho ou o nome da tela não bate com o que a equipe procura.");

    return {
      ...base, restricted: false, state,
      sample: { views: views.length, users: users.size, sessions: sessions.size, minViews: MIN_VIEWS, minUsers: MIN_USERS },
      topScreens,
      entry: { primary, explorar, explorarSharePct: primary + explorar > 0 ? Math.round((explorar / (primary + explorar)) * 100) : null },
      hoje: { opens: hojeOpens, actionClicks: hojeActs, actionRatePct: hojeOpens > 0 ? Math.round((hojeActs / hojeOpens) * 100) : null },
      falatuQuestions: { total: fq.length, withStore: fq.filter((r) => r.module_key === "com_loja").length, followUps: fq.filter((r) => r.module_key === "continuacao").length },
      searchMisses, notes,
    };
  }
}
export default UxPilotReportService;
