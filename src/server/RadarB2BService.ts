import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ProspectService } from "./ProspectService.js";

/**
 * Radar B2B (PRD Radar B2B) — busca empresas REAIS da base pública da Receita
 * Federal (município do Rio) num raio a partir de um ponto geocodificado, e
 * importa as selecionadas para o fluxo Prospect existente.
 *
 * A base fica num SQLite SEPARADO e read-only (data/radar_rio.db), gerado pelo
 * ETL em tools/radar_etl. Este serviço NÃO cria nada no banco principal, exceto
 * o cache de geocode de fallback (radar_cep_geo_cache), permitido pelo PRD.
 */

const RADAR_DB_PATH = process.env.RADAR_DB_PATH || "data/radar_rio.db";

// Normalização de nome idêntica à do Prospect (dedupe consistente entre os dois).
function normName(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\b(ltda|me|eireli|s\.?a\.?|epp|cia|company|inc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PORTE_LABEL: Record<string, string> = { "00": "Não informado", "01": "ME", "03": "EPP", "05": "Demais" };

export interface RadarSearchParams {
  lat: number; lon: number; radiusKm: number;
  cnaePrefix?: string;
  porte?: ("01" | "03" | "05")[];
  capitalMin?: number;
  comTelefone?: boolean;
  comEmail?: boolean;
  limit?: number;
}

export class RadarB2BService {
  private static _radar: Database.Database | null = null;
  private static _cacheReady = false;

  /** Abre (uma vez) a base do radar em modo read-only. Retorna null se não instalada. */
  private static radar(): Database.Database | null {
    if (this._radar) return this._radar;
    try {
      this._radar = new Database(RADAR_DB_PATH, { readonly: true, fileMustExist: true });
      return this._radar;
    } catch {
      return null;
    }
  }

  private static ensureCache() {
    if (this._cacheReady) return;
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS radar_cep_geo_cache (cep TEXT PRIMARY KEY, lat REAL, lon REAL, resolved_at TEXT)`);
      this._cacheReady = true;
    } catch { /* noop */ }
  }

  static isInstalled(): boolean {
    return !!this.radar();
  }

  /** Metadados da base para a tela (instalado? total? mês da base?). */
  static status(): { instalado: boolean; totalEmpresas: number; totalCeps: number; dataBase: string | null } {
    const r = this.radar();
    if (!r) return { instalado: false, totalEmpresas: 0, totalCeps: 0, dataBase: null };
    const meta = (k: string) => (r.prepare(`SELECT v FROM radar_meta WHERE k = ?`).get(k) as any)?.v ?? null;
    const count = (t: string) => { try { return (r.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number; } catch { return 0; } };
    return {
      instalado: true,
      totalEmpresas: Number(meta("total_empresas")) || count("empresas"),
      totalCeps: Number(meta("total_ceps")) || count("cep_geo"),
      dataBase: meta("base_month"),
    };
  }

  /**
   * Busca empresas no raio a partir de um ponto já geocodificado (a rota resolve
   * endereço/CEP → lat/lon). Retorna empresas ordenadas por distância + agregados
   * para os cards. NUNCA expõe o CPF mascarado dos sócios.
   */
  static search(p: RadarSearchParams): { ok: true; empresas: any[]; resumo: any } | { ok: false; error: string } {
    const r = this.radar();
    if (!r) return { ok: false, error: "Base do Radar B2B não instalada. Rode o ETL (tools/radar_etl)." };

    const radiusKm = Math.min(50, Math.max(0.1, Number(p.radiusKm) || 2));
    const limit = Math.min(500, Math.max(1, Number(p.limit) || 200));

    // 1) CEPs dentro do raio (bounding box em cep_geo → Haversine).
    const dLat = radiusKm / 111;
    const dLon = radiusKm / (111 * Math.cos((p.lat * Math.PI) / 180) || 1e-6);
    const cepRows = r.prepare(
      `SELECT cep, lat, lon FROM cep_geo WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`
    ).all(p.lat - dLat, p.lat + dLat, p.lon - dLon, p.lon + dLon) as any[];
    const cepDist = new Map<string, number>();
    for (const c of cepRows) {
      const dist = haversineKm(p.lat, p.lon, c.lat, c.lon);
      if (dist <= radiusKm) cepDist.set(String(c.cep), dist);
    }
    if (cepDist.size === 0) return { ok: true, empresas: [], resumo: this.emptyResumo() };

    // 2) Empresas nesses CEPs, em lotes de 500, com os filtros SQL.
    const filters: string[] = [];
    const fParams: any[] = [];
    if (p.cnaePrefix) { filters.push("cnae LIKE ?"); fParams.push(`${String(p.cnaePrefix).replace(/[^0-9]/g, "")}%`); }
    const portes = (p.porte || []).filter(x => ["01", "03", "05"].includes(x));
    if (portes.length) { filters.push(`porte IN (${portes.map(() => "?").join(",")})`); fParams.push(...portes); }
    if (p.capitalMin != null && Number(p.capitalMin) > 0) { filters.push("capital_social >= ?"); fParams.push(Number(p.capitalMin)); }
    if (p.comTelefone) filters.push("telefone1 != ''");
    if (p.comEmail) filters.push("email != ''");
    const filterSql = filters.length ? " AND " + filters.join(" AND ") : "";

    const ceps = Array.from(cepDist.keys());
    const matched: any[] = [];
    for (let i = 0; i < ceps.length; i += 500) {
      const chunk = ceps.slice(i, i + 500);
      const rows = r.prepare(
        `SELECT cnpj, cnpj_basico, razao_social, nome_fantasia, cnae, porte, capital_social,
                bairro, cep, telefone1, telefone2, email, data_inicio, situacao
           FROM empresas WHERE cep IN (${chunk.map(() => "?").join(",")})${filterSql}`
      ).all(...chunk, ...fParams) as any[];
      for (const e of rows) { e.distanciaKm = cepDist.get(String(e.cep)) ?? null; matched.push(e); }
    }

    matched.sort((a, b) => (a.distanciaKm ?? 1e9) - (b.distanciaKm ?? 1e9));

    // 3) Agregados (sobre TODOS os matched, antes do corte por limit).
    const resumo = this.buildResumo(r, matched);

    // 4) Enriquece só a página retornada (descrição CNAE + sócios, máx 5, sem CPF).
    const page = matched.slice(0, limit).map(e => {
      const cnaeDesc = (r.prepare(`SELECT descricao FROM cnaes WHERE codigo = ?`).get(String(e.cnae)) as any)?.descricao || null;
      const socios = (r.prepare(
        `SELECT nome, qualificacao, faixa_etaria FROM socios WHERE cnpj_basico = ? LIMIT 5`
      ).all(String(e.cnpj_basico)) as any[]).map(s => ({ nome: s.nome, qualificacao: s.qualificacao, faixaEtaria: s.faixa_etaria }));
      return {
        cnpj: e.cnpj, razaoSocial: e.razao_social, nomeFantasia: e.nome_fantasia || null,
        cnae: e.cnae, cnaeDescricao: cnaeDesc, porte: e.porte, porteLabel: PORTE_LABEL[e.porte] || "—",
        capitalSocial: Number(e.capital_social) || 0, bairro: e.bairro || null, cep: e.cep,
        telefone1: e.telefone1 || null, telefone2: e.telefone2 || null, email: e.email || null,
        dataInicio: e.data_inicio || null,
        distanciaKm: e.distanciaKm != null ? Math.round(e.distanciaKm * 100) / 100 : null,
        socios,
      };
    });

    return { ok: true, empresas: page, resumo };
  }

  private static emptyResumo() {
    return { total: 0, comTelefone: 0, comEmail: 0, porPorte: { ME: 0, EPP: 0, Demais: 0 }, topCnaes: [] };
  }

  private static buildResumo(r: Database.Database, matched: any[]) {
    const resumo = this.emptyResumo();
    resumo.total = matched.length;
    const cnaeCount = new Map<string, number>();
    for (const e of matched) {
      if (e.telefone1) resumo.comTelefone++;
      if (e.email) resumo.comEmail++;
      if (e.porte === "01") resumo.porPorte.ME++;
      else if (e.porte === "03") resumo.porPorte.EPP++;
      else if (e.porte === "05") resumo.porPorte.Demais++;
      const k = String(e.cnae || "");
      if (k) cnaeCount.set(k, (cnaeCount.get(k) || 0) + 1);
    }
    resumo.topCnaes = Array.from(cnaeCount.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([cnae, count]) => ({
        cnae, count,
        descricao: (r.prepare(`SELECT descricao FROM cnaes WHERE codigo = ?`).get(cnae) as any)?.descricao || null,
      }));
    return resumo;
  }

  /**
   * Importa CNPJs selecionados para o fluxo Prospect, no padrão EXATO do módulo
   * existente (mesmas tabelas/colunas de createFromResults/importRecords). Cria
   * a conta, a fonte de dados, sinais firmográficos e contato; roda
   * generateHypotheses + computeScore (best-effort). NÃO cria rascunho de outreach.
   */
  static async importToProspect(orgId: string, campaignId: string | null, cnpjs: string[], actorId?: string): Promise<{ created: number; skipped: number }> {
    const r = this.radar();
    if (!r) throw new Error("Base do Radar B2B não instalada. Rode o ETL (tools/radar_etl).");
    const list = Array.from(new Set((cnpjs || []).map(c => String(c).replace(/[^0-9]/g, "")).filter(c => c.length >= 8))).slice(0, 500);
    if (!list.length) throw new Error("Nenhum CNPJ informado para importar.");

    // Fonte de dados (uma por importação) — provider rfb_open_data, termos públicos.
    const sourceId = uuidv4();
    db.prepare(
      `INSERT INTO prospect_data_sources (id, organization_id, provider, source_reference, terms_profile, retention_policy, confidence)
       VALUES (?, ?, 'rfb_open_data', ?, 'public', 'public_data', 0.9)`
    ).run(sourceId, orgId, `RFB dados abertos — Rio (${list.length} empresas)`);

    const insAcc = db.prepare(
      `INSERT INTO prospect_accounts (id, organization_id, campaign_id, display_name, domain, website_url, industry, city, state, cnpj, source_id, source, account_status, dedupe_key, external_ref)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'Rio de Janeiro', 'RJ', ?, ?, 'rfb_open_data', 'discovered', ?, ?)`
    );
    const insSig = db.prepare(
      `INSERT INTO prospect_signals (id, organization_id, prospect_account_id, signal_type, observation, evidence_reference, confidence, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'connector')`
    );
    const insContact = db.prepare(
      `INSERT INTO prospect_contacts (id, organization_id, prospect_account_id, full_name, role_title, email, email_status, phone, source_id, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.9)`
    );
    const findByRef = db.prepare(`SELECT id FROM prospect_accounts WHERE organization_id = ? AND external_ref = ?`);
    const findByKey = db.prepare(`SELECT id FROM prospect_accounts WHERE organization_id = ? AND dedupe_key = ?`);

    let created = 0, skipped = 0;
    const newIds: string[] = [];

    const tx = db.transaction(() => {
      for (const cnpj of list) {
        const e = r.prepare(
          `SELECT cnpj, cnpj_basico, razao_social, nome_fantasia, cnae, porte, capital_social, situacao, data_inicio, telefone1, email
             FROM empresas WHERE cnpj = ?`
        ).get(cnpj) as any;
        if (!e || !e.razao_social) { skipped++; continue; }

        const ref = `cnpj/${cnpj}`;
        const key = normName(e.razao_social);
        if (findByRef.get(orgId, ref) || (key && findByKey.get(orgId, key))) { skipped++; continue; }

        const accId = uuidv4();
        insAcc.run(accId, orgId, campaignId || null, e.razao_social, null, cnpj, sourceId, key || cnpj, ref);
        newIds.push(accId);

        // Sinais firmográficos (source_kind='connector').
        const porteLabel = PORTE_LABEL[e.porte] || "porte não informado";
        const cap = Number(e.capital_social) || 0;
        insSig.run(uuidv4(), orgId, accId, "outro", `Porte: ${porteLabel}. Capital social: R$ ${cap.toLocaleString("pt-BR")}.`, ref, 0.9);
        if (e.situacao === "02") insSig.run(uuidv4(), orgId, accId, "outro", "Situação cadastral ATIVA na Receita Federal.", ref, 0.9);
        insSig.run(uuidv4(), orgId, accId, "cobertura_digital", "Sem site informado na base pública (oportunidade de presença digital).", ref, 0.6);
        if (e.data_inicio && /^\d{8}$/.test(String(e.data_inicio))) {
          const ano = parseInt(String(e.data_inicio).slice(0, 4), 10);
          const anos = new Date().getFullYear() - ano;
          if (anos >= 0 && anos < 200) insSig.run(uuidv4(), orgId, accId, "outro", `Empresa com ~${anos} ano(s) de atividade (desde ${ano}).`, ref, 0.9);
        }

        // Contato: sócio-administrador (se houver) como nome + telefone/email da empresa.
        const socio = r.prepare(
          `SELECT nome FROM socios WHERE cnpj_basico = ? AND qualificacao IN ('49','10','05','16','65') LIMIT 1`
        ).get(String(e.cnpj_basico)) as any;
        const fullName = socio?.nome || null;
        const phone = String(e.telefone1 || "").replace(/[^0-9]/g, "");
        const email = String(e.email || "").trim().toLowerCase();
        if (fullName || phone || email) {
          insContact.run(uuidv4(), orgId, accId, fullName, socio ? "Sócio-administrador" : null, email, email ? "publicly_listed" : "unknown", phone || "", sourceId);
        }
        created++;
      }
    });
    tx();

    // Hipóteses + score (best-effort, mesma ordem do orchestrate). Não cria draft.
    for (const id of newIds) {
      try { await ProspectService.generateHypotheses(orgId, id); } catch { /* best-effort */ }
      try { ProspectService.computeScore(orgId, id); } catch { /* best-effort */ }
    }

    try { logAuthEvent(orgId, actorId || null, null, "RADAR_B2B_IMPORT", { created, skipped, source: "rfb_open_data", campaignId: campaignId || null }); } catch { /* noop */ }
    return { created, skipped };
  }
}
