import db from "./db.js";
import { randomUUID } from "node:crypto";
import { chat } from "./llm.js";
import { expectedSegments, norm as normCat } from "./prospectCategories.js";

/**
 * Prospect AI — Inteligência de Prospecção B2B (Fase 0: fundação).
 * Aqui ficam o ICP (perfil de conta ideal) e as Campanhas em rascunho.
 * Descoberta, enriquecimento, evidências, score e outreach entram nas próximas
 * fases. Determinístico/read-write; nada de IA ainda nesta camada.
 *
 * Princípios do PRD respeitados desde já: nada de scraping; campanha nasce em
 * RASCUNHO; tudo escopado por organização (multi-tenant).
 */
const OBJECTIVES = ["reuniao", "diagnostico", "evento", "proposta"];
const APPROVAL = ["manual", "manager", "auto_rules"];

const onlyDigits = (s: any) => String(s || "").replace(/\D/g, "");
// Domínio normalizado a partir de site OU e-mail (sem protocolo/www/caminho).
function normDomain(...candidates: any[]): string {
  for (const c of candidates) {
    let v = String(c || "").trim().toLowerCase();
    if (!v) continue;
    if (v.includes("@")) v = v.split("@")[1] || "";
    v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].trim();
    if (v && v.includes(".")) return v;
  }
  return "";
}
// Nome normalizado para deduplicar empresa (sem acento, pontuação e sufixos).
function normName(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(ltda|me|eireli|s\.?a\.?|epp|cia|company|inc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCriteria(raw: any): any {
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return {}; }
}

export class ProspectService {
  // ── ICP (perfil de conta ideal) ─────────────────────────────────────────
  static listIcps(orgId: string): any[] {
    const rows = db.prepare(
      "SELECT * FROM prospect_icp_profiles WHERE organization_id = ? AND status != 'archived' ORDER BY created_at DESC"
    ).all(orgId) as any[];
    return rows.map(r => ({ ...r, criteria: parseCriteria(r.criteria_json) }));
  }

  static createIcp(orgId: string, input: { name?: string; vertical?: string; criteria?: any }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome ao ICP.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO prospect_icp_profiles (id, organization_id, name, vertical, criteria_json, status, created_by) VALUES (?, ?, ?, ?, ?, 'active', ?)"
    ).run(id, orgId, name, String(input?.vertical || ""), JSON.stringify(input?.criteria || {}), actorId || null);
    return this.getIcp(orgId, id);
  }

  static getIcp(orgId: string, id: string): any {
    const r = db.prepare("SELECT * FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    return r ? { ...r, criteria: parseCriteria(r.criteria_json) } : null;
  }

  static updateIcp(orgId: string, id: string, patch: any): any {
    const cur = db.prepare("SELECT id FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!cur) throw new Error("ICP não encontrado.");
    const fields: string[] = [], params: any[] = [];
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (n) { fields.push("name = ?"); params.push(n); } }
    if (patch.vertical !== undefined) { fields.push("vertical = ?"); params.push(String(patch.vertical || "")); }
    if (patch.criteria !== undefined) { fields.push("criteria_json = ?"); params.push(JSON.stringify(patch.criteria || {})); }
    if (!fields.length) return this.getIcp(orgId, id);
    params.push(id, orgId);
    db.prepare(`UPDATE prospect_icp_profiles SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    return this.getIcp(orgId, id);
  }

  static archiveIcp(orgId: string, id: string): boolean {
    const r = db.prepare("UPDATE prospect_icp_profiles SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status != 'archived'").run(id, orgId);
    return r.changes > 0;
  }

  // ── Campanhas (nascem em rascunho) ──────────────────────────────────────
  static listCampaigns(orgId: string): any[] {
    return db.prepare(`
      SELECT c.*, i.name AS icp_name
      FROM prospect_campaigns c
      LEFT JOIN prospect_icp_profiles i ON i.id = c.icp_id
      WHERE c.organization_id = ? AND c.status != 'archived'
      ORDER BY c.created_at DESC
    `).all(orgId) as any[];
  }

  static createCampaign(orgId: string, input: {
    name?: string; icpId?: string; objective?: string; budgetLimit?: number; dailyLimit?: number; approvalMode?: string;
  }, actorId?: string): any {
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("Dê um nome à campanha.");
    if (input?.icpId) {
      const icp = db.prepare("SELECT id FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(input.icpId, orgId);
      if (!icp) throw new Error("ICP selecionado não existe.");
    }
    const objective = OBJECTIVES.includes(String(input?.objective)) ? input.objective : "reuniao";
    const approval = APPROVAL.includes(String(input?.approvalMode)) ? input.approvalMode : "manual";
    const id = randomUUID();
    db.prepare(`
      INSERT INTO prospect_campaigns (id, organization_id, icp_id, name, objective, status, budget_limit_brl, daily_contact_limit, approval_mode, created_by)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, orgId, input?.icpId || null, name, objective, Math.max(0, Number(input?.budgetLimit) || 0), Math.max(0, parseInt(String(input?.dailyLimit), 10) || 0), approval, actorId || null);
    return this.getCampaign(orgId, id);
  }

  static getCampaign(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
  }

  static updateCampaign(orgId: string, id: string, patch: any): any {
    const cur = db.prepare("SELECT id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(id, orgId);
    if (!cur) throw new Error("Campanha não encontrada.");
    const fields: string[] = [], params: any[] = [];
    if (patch.name !== undefined) { const n = String(patch.name).trim(); if (n) { fields.push("name = ?"); params.push(n); } }
    if (patch.objective !== undefined && OBJECTIVES.includes(patch.objective)) { fields.push("objective = ?"); params.push(patch.objective); }
    if (patch.icpId !== undefined) { fields.push("icp_id = ?"); params.push(patch.icpId || null); }
    if (patch.budgetLimit !== undefined) { fields.push("budget_limit_brl = ?"); params.push(Math.max(0, Number(patch.budgetLimit) || 0)); }
    if (patch.dailyLimit !== undefined) { fields.push("daily_contact_limit = ?"); params.push(Math.max(0, parseInt(String(patch.dailyLimit), 10) || 0)); }
    if (patch.approvalMode !== undefined && APPROVAL.includes(patch.approvalMode)) { fields.push("approval_mode = ?"); params.push(patch.approvalMode); }
    // Transições de status (draft → active/paused/...) — somente valores válidos.
    if (patch.status !== undefined && ["draft", "active", "paused", "completed", "archived"].includes(patch.status)) { fields.push("status = ?"); params.push(patch.status); }
    if (!fields.length) return this.getCampaign(orgId, id);
    params.push(id, orgId);
    db.prepare(`UPDATE prospect_campaigns SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params);
    return this.getCampaign(orgId, id);
  }

  // ── Importação de contas/contatos (CSV) + deduplicação ──────────────────
  /**
   * Importa registros JÁ normalizados (o front faz o parse/mapeamento do CSV).
   * Cada registro: { company, domain, website, city, state, industry, cnpj,
   * contactName, role, email, phone }. Deduplica conta por domínio (ou nome) e
   * contato por e-mail/telefone. Registra a fonte (origem + política).
   */
  static importRecords(orgId: string, input: { campaignId?: string; sourceRef?: string; records: any[] }, _actorId?: string):
    { sourceId: string; accountsCreated: number; accountsMerged: number; contactsCreated: number; contactsSkipped: number; total: number } {
    const records = Array.isArray(input?.records) ? input.records.slice(0, 5000) : [];
    if (!records.length) throw new Error("Nenhum registro para importar.");
    if (input?.campaignId) {
      const c = db.prepare("SELECT id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(input.campaignId, orgId);
      if (!c) throw new Error("Campanha não encontrada.");
    }
    const sourceId = randomUUID();
    db.prepare("INSERT INTO prospect_data_sources (id, organization_id, provider, source_reference, terms_profile, retention_policy, confidence) VALUES (?, ?, 'csv_import', ?, 'user_provided', 'tenant_policy', 1.0)")
      .run(sourceId, orgId, String(input?.sourceRef || "importação CSV"));

    let accountsCreated = 0, accountsMerged = 0, contactsCreated = 0, contactsSkipped = 0;
    const findAccount = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND dedupe_key = ?");
    const insAccount = db.prepare(`INSERT INTO prospect_accounts (id, organization_id, campaign_id, display_name, domain, website_url, industry, city, state, cnpj, source_id, source, account_status, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv_import', 'discovered', ?)`);
    const findContact = db.prepare("SELECT id FROM prospect_contacts WHERE organization_id = ? AND prospect_account_id = ? AND ((email != '' AND email = ?) OR (phone != '' AND phone = ?))");
    const insContact = db.prepare(`INSERT INTO prospect_contacts (id, organization_id, prospect_account_id, full_name, role_title, email, email_status, phone, source_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.6)`);

    const tx = db.transaction(() => {
      for (const r of records) {
        const company = String(r?.company || "").trim();
        const email = String(r?.email || "").trim().toLowerCase();
        const phone = onlyDigits(r?.phone);
        const contactName = String(r?.contactName || "").trim();
        const domain = normDomain(r?.domain, r?.website, email);
        const dedupeKey = domain || normName(company);
        if (!dedupeKey) continue; // linha sem empresa nem domínio → ignora

        const acc = findAccount.get(orgId, dedupeKey) as any;
        let accId: string;
        if (acc) { accId = acc.id; accountsMerged++; }
        else {
          accId = randomUUID();
          insAccount.run(accId, orgId, input?.campaignId || null, company || domain, domain || null,
            String(r?.website || "").trim() || null, String(r?.industry || "").trim() || null,
            String(r?.city || "").trim() || null, String(r?.state || "").trim() || null,
            onlyDigits(r?.cnpj) || null, sourceId, dedupeKey);
          accountsCreated++;
        }

        if (email || phone || contactName) {
          const dup = (email || phone) ? findContact.get(orgId, accId, email, phone) : null;
          if (dup) { contactsSkipped++; }
          else {
            insContact.run(randomUUID(), orgId, accId, contactName || null, String(r?.role || "").trim() || null,
              email || "", email ? "publicly_listed" : "unknown", phone || "", sourceId);
            contactsCreated++;
          }
        }
      }
    });
    tx();
    return { sourceId, accountsCreated, accountsMerged, contactsCreated, contactsSkipped, total: records.length };
  }

  static listAccounts(orgId: string, opts: { campaignId?: string; q?: string } = {}): any[] {
    let sql = `
      SELECT a.*, (SELECT COUNT(*) FROM prospect_contacts c WHERE c.prospect_account_id = a.id) AS contacts_count
      FROM prospect_accounts a WHERE a.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.campaignId) { sql += " AND a.campaign_id = ?"; params.push(opts.campaignId); }
    if (opts.q) { sql += " AND (a.display_name LIKE ? OR a.domain LIKE ?)"; params.push(`%${opts.q}%`, `%${opts.q}%`); }
    sql += " ORDER BY a.created_at DESC LIMIT 500";
    return db.prepare(sql).all(...params) as any[];
  }

  static getAccount(orgId: string, id: string): any {
    const a = db.prepare("SELECT * FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!a) return null;
    a.contacts = db.prepare("SELECT * FROM prospect_contacts WHERE prospect_account_id = ? AND organization_id = ? ORDER BY created_at ASC").all(id, orgId) as any[];
    a.signals = db.prepare("SELECT * FROM prospect_signals WHERE prospect_account_id = ? AND organization_id = ? ORDER BY created_at DESC").all(id, orgId) as any[];
    a.hypotheses = db.prepare("SELECT * FROM prospect_hypotheses WHERE prospect_account_id = ? AND organization_id = ? AND status != 'rejected' ORDER BY created_at DESC").all(id, orgId) as any[];
    a.score = db.prepare("SELECT * FROM prospect_score_snapshots WHERE prospect_account_id = ? AND organization_id = ? ORDER BY calculated_at DESC LIMIT 1").get(id, orgId) as any || null;
    a.outreach = db.prepare("SELECT * FROM prospect_outreach WHERE prospect_account_id = ? AND organization_id = ? AND status != 'rejected' ORDER BY created_at DESC").all(id, orgId) as any[];
    return a;
  }

  // ── Evidências (ledger) ─────────────────────────────────────────────────
  static addSignal(orgId: string, accountId: string, input: { signalType?: string; observation?: string; evidenceReference?: string; confidence?: number }): any {
    const acc = db.prepare("SELECT id FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId);
    if (!acc) throw new Error("Conta não encontrada.");
    const obs = String(input?.observation || "").trim();
    if (!obs) throw new Error("Descreva o dado observado.");
    db.prepare("INSERT INTO prospect_signals (id, organization_id, prospect_account_id, signal_type, observation, evidence_reference, confidence, source_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'user')")
      .run(randomUUID(), orgId, accountId, String(input?.signalType || "outro"), obs, String(input?.evidenceReference || "").trim() || null, Math.max(0, Math.min(1, Number(input?.confidence) || 0.6)));
    return this.getAccount(orgId, accountId);
  }

  static removeSignal(orgId: string, accountId: string, signalId: string): any {
    db.prepare("DELETE FROM prospect_signals WHERE id = ? AND prospect_account_id = ? AND organization_id = ?").run(signalId, accountId, orgId);
    return this.getAccount(orgId, accountId);
  }

  // ── Hipóteses de dor (IA, com evidência) ────────────────────────────────
  static async generateHypotheses(orgId: string, accountId: string): Promise<any> {
    const acc = db.prepare("SELECT * FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const signals = db.prepare("SELECT signal_type, observation, evidence_reference FROM prospect_signals WHERE prospect_account_id = ? AND organization_id = ?").all(accountId, orgId) as any[];
    if (!signals.length) throw new Error("Adicione ao menos uma evidência antes de gerar hipóteses.");
    // Contexto do ICP, se a conta estiver ligada a uma campanha com ICP.
    let icpLine = "";
    if (acc.campaign_id) {
      const camp = db.prepare("SELECT icp_id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(acc.campaign_id, orgId) as any;
      if (camp?.icp_id) {
        const icp = this.getIcp(orgId, camp.icp_id);
        if (icp) icpLine = `ICP-alvo: ${icp.name}. Dor prioritária do ICP: ${icp.criteria?.dor || "n/d"}. Oferta: ${icp.criteria?.oferta || "n/d"}.`;
      }
    }
    const evid = signals.map((s, i) => `(${i + 1}) [${s.signal_type}] ${s.observation}${s.evidence_reference ? ` — fonte: ${s.evidence_reference}` : ""}`).join("\n");
    const prompt = `Você é um analista de prospecção B2B. Com base SOMENTE nas evidências abaixo, gere de 1 a 3 HIPÓTESES de dor para a empresa "${acc.display_name}".
${icpLine}
REGRAS:
- Hipótese em linguagem PROBABILÍSTICA (ex.: "pode haver", "talvez"), NUNCA afirmação de fato.
- NÃO invente dados, números, reclamações ou falhas que não estejam nas evidências.
- Cada hipótese deve citar quais evidências a sustentam (pelos números).
- Tom respeitoso, sem acusação ou comparação depreciativa.

EVIDÊNCIAS:
${evid}

Responda em JSON: {"hypotheses":[{"hypothesis":"...","evidence":[1,2],"recommended_question":"pergunta de descoberta","related_capability":"RIC|CRM|Copiloto|Estúdio|...","confidence":"baixa|media|alta"}]}`;
    let arr: any[] = [];
    try {
      const raw = await chat(prompt, { temperature: 0.4, json: true });
      const j = JSON.parse(raw);
      arr = Array.isArray(j?.hypotheses) ? j.hypotheses.slice(0, 3) : [];
    } catch { arr = []; }
    const ins = db.prepare("INSERT INTO prospect_hypotheses (id, organization_id, prospect_account_id, hypothesis, evidence_refs, recommended_question, related_capability, confidence, status, created_by_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'ai')");
    for (const h of arr) {
      const text = String(h?.hypothesis || "").trim();
      if (!text) continue;
      const refs = Array.isArray(h?.evidence) ? h.evidence.map((n: any) => signals[Number(n) - 1]?.observation).filter(Boolean) : [];
      const conf = ["baixa", "media", "alta"].includes(String(h?.confidence)) ? h.confidence : "media";
      ins.run(randomUUID(), orgId, accountId, text, JSON.stringify(refs), String(h?.recommended_question || "").trim() || null, String(h?.related_capability || "").trim() || null, conf);
    }
    return this.getAccount(orgId, accountId);
  }

  static setHypothesisStatus(orgId: string, accountId: string, hypId: string, status: string): any {
    if (!["draft", "approved", "rejected"].includes(status)) throw new Error("Status inválido.");
    db.prepare("UPDATE prospect_hypotheses SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND prospect_account_id = ? AND organization_id = ?").run(status, hypId, accountId, orgId);
    return this.getAccount(orgId, accountId);
  }

  // ── Score de aderência/prioridade (determinístico, explicável) ───────────
  static computeScore(orgId: string, accountId: string): any {
    const acc = db.prepare("SELECT * FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const contacts = db.prepare("SELECT * FROM prospect_contacts WHERE prospect_account_id = ? AND organization_id = ?").all(accountId, orgId) as any[];
    const signals = db.prepare("SELECT confidence FROM prospect_signals WHERE prospect_account_id = ? AND organization_id = ?").all(accountId, orgId) as any[];
    const approvedHyp = db.prepare("SELECT COUNT(*) n FROM prospect_hypotheses WHERE prospect_account_id = ? AND organization_id = ? AND status = 'approved'").get(accountId, orgId) as any;
    const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

    // Confiança do dado: completude do cadastro da empresa.
    const fields = [acc.domain, acc.website_url, acc.industry, acc.city, acc.cnpj].filter(Boolean).length;
    const dataConfidence = clamp(40 + fields * 12);
    // Aderência: empresa "real" (com domínio) + setor/cidade preenchidos…
    let accountFit = clamp(45 + (acc.domain ? 25 : 0) + (acc.industry ? 15 : 0) + (acc.city ? 15 : 0));
    // …ajustada pelo ENCAIXE com o ICP: se o ICP define um segmento e o setor da
    // conta não bate, derruba a aderência (e dá um leve reforço quando bate).
    const expected = this.icpExpectedSegments(orgId, acc.campaign_id);
    let icpMatch: boolean | null = null;
    if (expected.size) {
      const seg = normCat(acc.industry).replace(/\s+/g, "_");
      icpMatch = !!seg && [...expected].some(e => seg === e || seg.includes(e) || e.includes(seg));
      accountFit = clamp(icpMatch ? accountFit + 10 : accountFit * 0.5);
    }
    // Contatabilidade: e-mail + telefone + nome.
    const hasEmail = contacts.some(c => (c.email || "").includes("@") && c.email_status !== "invalid" && c.email_status !== "suppressed");
    const hasPhone = contacts.some(c => c.phone);
    const hasName = contacts.some(c => c.full_name);
    const reachability = clamp((hasEmail ? 45 : 0) + (hasPhone ? 35 : 0) + (hasName ? 20 : 0));
    // Evidência de dor: nº de evidências + hipóteses aprovadas.
    const painEvidence = clamp(signals.length * 18 + Number(approvedHyp?.n || 0) * 25);
    // Conformidade: cai se algum contato em opt-out; sobe com fonte registrada.
    const optedOut = contacts.some(c => c.opt_out_at);
    const compliance = clamp((acc.source_id ? 80 : 60) + (optedOut ? -40 : 20));
    // Prioridade (pesos do PRD).
    const priority = clamp(accountFit * 0.35 + painEvidence * 0.20 + reachability * 0.15 + dataConfidence * 0.15 + compliance * 0.15);

    const explanation = { fields, hasEmail, hasPhone, hasName, signals: signals.length, approvedHyp: Number(approvedHyp?.n || 0), optedOut, icpMatch };
    db.prepare("INSERT INTO prospect_score_snapshots (id, organization_id, prospect_account_id, account_fit, pain_evidence, reachability, data_confidence, compliance, priority, explanation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), orgId, accountId, accountFit, painEvidence, reachability, dataConfidence, compliance, priority, JSON.stringify(explanation));
    return { account_fit: accountFit, pain_evidence: painEvidence, reachability, data_confidence: dataConfidence, compliance, priority, explanation };
  }

  /** Segmentos esperados pelo ICP da campanha (vazio = sem segmento definido). */
  private static icpExpectedSegments(orgId: string, campaignId?: string): Set<string> {
    if (!campaignId) return new Set();
    const camp = db.prepare("SELECT icp_id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(campaignId, orgId) as any;
    if (!camp?.icp_id) return new Set();
    const icp = db.prepare("SELECT name, vertical, criteria_json FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(camp.icp_id, orgId) as any;
    if (!icp) return new Set();
    let crit: any = {}; try { crit = JSON.parse(icp.criteria_json || "{}"); } catch { /* ignora */ }
    const terms = [icp.vertical, icp.name, crit?.segmento, crit?.sinais].filter(Boolean).join(", ");
    return expectedSegments(terms);
  }

  static updateAccountStatus(orgId: string, id: string, status: string): boolean {
    if (!["discovered", "researching", "qualified", "disqualified", "contacted", "converted"].includes(status)) throw new Error("Status inválido.");
    const r = db.prepare("UPDATE prospect_accounts SET account_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(status, id, orgId);
    return r.changes > 0;
  }

  // ── Composer de abordagem (IA) + fila de aprovação ──────────────────────
  /**
   * Gera um RASCUNHO de abordagem (e-mail/WhatsApp/ligação) a partir das
   * EVIDÊNCIAS e HIPÓTESES APROVADAS + oferta/CTA do ICP. Guardrails do PRD:
   * pergunta (não acusação), 1 CTA, sem inventar dado, opt-out no e-mail.
   * Nasce em 'draft'.
   */
  static async composeOutreach(orgId: string, accountId: string, input: { contactId?: string; channel?: string }): Promise<any> {
    const acc = db.prepare("SELECT * FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(accountId, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const channel = ["email", "whatsapp", "call", "linkedin_manual"].includes(String(input?.channel)) ? input!.channel! : "email";
    const biz = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const signals = db.prepare("SELECT observation FROM prospect_signals WHERE prospect_account_id = ? AND organization_id = ?").all(accountId, orgId) as any[];
    const hyps = db.prepare("SELECT hypothesis, recommended_question FROM prospect_hypotheses WHERE prospect_account_id = ? AND organization_id = ? AND status = 'approved'").all(accountId, orgId) as any[];
    let contact: any = null;
    if (input?.contactId) contact = db.prepare("SELECT full_name, role_title, email FROM prospect_contacts WHERE id = ? AND prospect_account_id = ? AND organization_id = ?").get(input.contactId, accountId, orgId);
    let icp: any = null;
    if (acc.campaign_id) {
      const camp = db.prepare("SELECT icp_id FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(acc.campaign_id, orgId) as any;
      if (camp?.icp_id) icp = this.getIcp(orgId, camp.icp_id);
    }
    const fmt = channel === "email" ? "um E-MAIL curto (assunto + corpo)" : channel === "call" ? "um ROTEIRO de ligação curto" : channel === "whatsapp" ? "uma mensagem de WhatsApp curta" : "uma nota curta de LinkedIn (uso manual)";
    const prompt = `Você redige uma abordagem comercial B2B (${fmt}) para a empresa "${acc.display_name}"${contact?.full_name ? `, falando com ${contact.full_name}${contact.role_title ? ` (${contact.role_title})` : ""}` : ""}, em nome de "${biz?.business_name || "nossa empresa"}".
REGRAS (obrigatórias):
- Contexto observável e NÃO invasivo. Hipótese como PERGUNTA, nunca acusação.
- NÃO invente dados, números, reclamações, cases ou prova social.
- 1 chamada para ação pequena e clara.
${channel === "email" ? "- No fim do e-mail, inclua uma linha curta de descadastro (opt-out)." : ""}
- Tom respeitoso e direto, em português do Brasil.

EVIDÊNCIAS OBSERVADAS:
${signals.map((s, i) => `(${i + 1}) ${s.observation}`).join("\n") || "(sem evidências registradas)"}
HIPÓTESES APROVADAS / PERGUNTAS DE DESCOBERTA:
${hyps.map(h => `- ${h.hypothesis}${h.recommended_question ? ` → ${h.recommended_question}` : ""}`).join("\n") || "(nenhuma)"}
${icp ? `OFERTA: ${icp.criteria?.oferta || "n/d"}. CTA desejado: ${icp.criteria?.cta || "conversa de 15 min"}.` : ""}

Responda em JSON: {"subject":"(vazio se não for e-mail)","body":"texto pronto para revisão"}`;
    let subject = "", body = "";
    try {
      const j = JSON.parse(await chat(prompt, { temperature: 0.6, json: true }));
      subject = String(j?.subject || "").trim();
      body = String(j?.body || "").trim();
    } catch { /* mantém vazio */ }
    if (!body) throw new Error("A IA não retornou a abordagem. Tente novamente.");
    const evidenceSnapshot = { signals: signals.map(s => s.observation), hypotheses: hyps.map(h => h.hypothesis) };
    const id = randomUUID();
    db.prepare("INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')")
      .run(id, orgId, acc.campaign_id || null, accountId, input?.contactId || null, channel, subject, body, JSON.stringify(evidenceSnapshot));
    return this.getAccount(orgId, accountId);
  }

  static updateOutreach(orgId: string, id: string, patch: { subject?: string; body?: string }): any {
    const o = db.prepare("SELECT prospect_account_id, status FROM prospect_outreach WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!o) throw new Error("Abordagem não encontrada.");
    if (o.status === "sent") throw new Error("Abordagem já enviada não pode ser editada.");
    const fields: string[] = [], params: any[] = [];
    if (patch.subject !== undefined) { fields.push("subject = ?"); params.push(String(patch.subject)); }
    if (patch.body !== undefined) { fields.push("body = ?"); params.push(String(patch.body)); }
    if (fields.length) { params.push(id, orgId); db.prepare(`UPDATE prospect_outreach SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params); }
    return this.getAccount(orgId, o.prospect_account_id);
  }

  /** Transições: draft→pending_approval; pending→approved/rejected/draft; approved→sent/rejected. */
  static setOutreachStatus(orgId: string, id: string, status: string, actorId?: string): any {
    const o = db.prepare("SELECT prospect_account_id, status FROM prospect_outreach WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!o) throw new Error("Abordagem não encontrada.");
    const allowed: Record<string, string[]> = {
      draft: ["pending_approval", "rejected"],
      pending_approval: ["approved", "rejected", "draft"],
      approved: ["sent", "rejected"],
      rejected: ["draft"],
      sent: [],
    };
    if (!(allowed[o.status] || []).includes(status)) throw new Error(`Transição inválida (${o.status} → ${status}).`);
    const sets = ["status = ?", "updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [status];
    if (status === "approved") { sets.push("approved_by = ?"); params.push(actorId || null); }
    if (status === "sent") { sets.push("sent_at = CURRENT_TIMESTAMP"); }
    params.push(id, orgId);
    db.prepare(`UPDATE prospect_outreach SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...params);
    return this.getAccount(orgId, o.prospect_account_id);
  }

  /** Fila de aprovação: abordagens pendentes (com nome da conta/contato). */
  static listApprovalQueue(orgId: string): any[] {
    return db.prepare(`
      SELECT o.*, a.display_name AS account_name, c.full_name AS contact_name, c.email AS contact_email
      FROM prospect_outreach o
      JOIN prospect_accounts a ON a.id = o.prospect_account_id
      LEFT JOIN prospect_contacts c ON c.id = o.contact_id
      WHERE o.organization_id = ? AND o.status = 'pending_approval'
      ORDER BY o.created_at ASC LIMIT 200
    `).all(orgId) as any[];
  }

  // ── Atribuição: receita originada pela prospecção + copiloto do SDR ──────
  /**
   * Registra o DESFECHO de uma conta: ganha (com valor REAL informado pelo SDR)
   * ou perdida (com motivo). Não toca na estimativa do RIC — é receita de fato.
   * 'won' → converted + won_value/won_at; 'lost' → disqualified + lost_reason;
   * 'reopen' → volta para 'qualified' e limpa o desfecho.
   */
  static recordOutcome(orgId: string, id: string, input: { outcome: string; wonValue?: number; lostReason?: string }): any {
    const acc = db.prepare("SELECT id FROM prospect_accounts WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!acc) throw new Error("Conta não encontrada.");
    const outcome = String(input?.outcome || "");
    if (outcome === "won") {
      const v = Math.max(0, Number(input?.wonValue) || 0);
      db.prepare("UPDATE prospect_accounts SET account_status = 'converted', won_value = ?, won_at = CURRENT_TIMESTAMP, lost_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(v, id, orgId);
    } else if (outcome === "lost") {
      db.prepare("UPDATE prospect_accounts SET account_status = 'disqualified', lost_reason = ?, won_value = NULL, won_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(String(input?.lostReason || "").trim() || null, id, orgId);
    } else if (outcome === "reopen") {
      db.prepare("UPDATE prospect_accounts SET account_status = 'qualified', won_value = NULL, won_at = NULL, lost_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
    } else {
      throw new Error("Desfecho inválido (use won, lost ou reopen).");
    }
    return this.getAccount(orgId, id);
  }

  /**
   * Resumo de atribuição: receita REAL originada pela prospecção (contas ganhas)
   * — total, nº de contas, em aberto (pipeline) e quebra por campanha.
   */
  static attributionSummary(orgId: string): any {
    const won = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(won_value), 0) AS total FROM prospect_accounts WHERE organization_id = ? AND account_status = 'converted'").get(orgId) as any;
    const lost = db.prepare("SELECT COUNT(*) AS n FROM prospect_accounts WHERE organization_id = ? AND account_status = 'disqualified'").get(orgId) as any;
    const pipeline = db.prepare("SELECT COUNT(*) AS n FROM prospect_accounts WHERE organization_id = ? AND account_status IN ('discovered','researching','qualified','contacted')").get(orgId) as any;
    const wonCount = Number(won?.n || 0);
    const totalWon = Number(won?.total || 0);
    const byCampaign = db.prepare(`
      SELECT a.campaign_id, c.name AS campaign_name,
             COUNT(*) AS won_count, COALESCE(SUM(a.won_value), 0) AS won_total
      FROM prospect_accounts a
      LEFT JOIN prospect_campaigns c ON c.id = a.campaign_id
      WHERE a.organization_id = ? AND a.account_status = 'converted'
      GROUP BY a.campaign_id ORDER BY won_total DESC
    `).all(orgId) as any[];
    return {
      totalWon, wonCount,
      lostCount: Number(lost?.n || 0),
      pipelineCount: Number(pipeline?.n || 0),
      winRate: wonCount + Number(lost?.n || 0) > 0 ? Math.round((wonCount / (wonCount + Number(lost?.n || 0))) * 100) : 0,
      avgDeal: wonCount > 0 ? Math.round(totalWon / wonCount) : 0,
      byCampaign: byCampaign.map(b => ({ campaignId: b.campaign_id, name: b.campaign_name || "(sem campanha)", wonCount: Number(b.won_count), wonTotal: Number(b.won_total) })),
    };
  }

  /**
   * Copiloto do SDR: sugere a PRÓXIMA MELHOR AÇÃO para a conta, com base só nos
   * dados registrados (evidências, hipóteses aprovadas, score, abordagens,
   * contatos). Não inventa dados; pensa como um SDR experiente e consultivo.
   */
  static async sdrCopilot(orgId: string, accountId: string): Promise<{ advice: string }> {
    const acc = this.getAccount(orgId, accountId);
    if (!acc) throw new Error("Conta não encontrada.");
    const biz = db.prepare("SELECT business_name, vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const signals = (acc.signals || []).map((s: any, i: number) => `(${i + 1}) ${s.observation}`).join("\n") || "(sem evidências)";
    const hyps = (acc.hypotheses || []).filter((h: any) => h.status === "approved").map((h: any) => `- ${h.hypothesis}`).join("\n") || "(nenhuma hipótese aprovada)";
    const sc = acc.score;
    const scoreLine = sc ? `Prioridade ${Math.round(sc.priority)} (aderência ${Math.round(sc.account_fit)}, dor ${Math.round(sc.pain_evidence)}, contatabilidade ${Math.round(sc.reachability)}).` : "(score ainda não calculado)";
    const outreach = (acc.outreach || []).map((o: any) => `${o.channel}: ${o.status}`).join("; ") || "(nenhuma abordagem)";
    const contacts = (acc.contacts || []).map((c: any) => `${c.full_name || "(sem nome)"}${c.role_title ? ` (${c.role_title})` : ""}${c.email ? ` <${c.email}>` : ""}`).join("; ") || "(sem contatos)";
    const prompt = `Você é o COPILOTO DO SDR — um pré-vendas B2B experiente e consultivo. Recomende a PRÓXIMA MELHOR AÇÃO para avançar esta conta, com base SÓ nos dados abaixo. Não invente dados. Português do Brasil, direto.
${biz?.business_name ? `Nossa empresa: ${biz.business_name}${biz?.vertical ? ` (${biz.vertical})` : ""}.` : ""}

CONTA: ${acc.display_name}${acc.industry ? ` · ${acc.industry}` : ""}${acc.city ? ` · ${acc.city}/${acc.state || ""}` : ""}
STATUS: ${acc.account_status}
SCORE: ${scoreLine}
CONTATOS: ${contacts}
EVIDÊNCIAS:\n${signals}
HIPÓTESES APROVADAS:\n${hyps}
ABORDAGENS: ${outreach}

Responda em no máximo ~120 palavras, neste formato:
1. PRÓXIMA AÇÃO (uma frase objetiva: o que fazer agora).
2. POR QUÊ (1 linha ligada às evidências/score).
3. SE FALTA DADO: o que descobrir antes (1 linha), quando aplicável.
Se faltar evidência/contato para agir bem, diga isso com franqueza.`;
    try {
      const advice = (await chat(prompt, { temperature: 0.4 })).trim();
      return { advice: advice || "Não consegui gerar a recomendação agora. Tente novamente." };
    } catch (e) {
      console.error("[ProspectAI] Falha no copiloto do SDR:", e);
      return { advice: "Não consegui gerar a recomendação agora. Tente novamente em instantes." };
    }
  }
}
