import db from "./db.js";
import { randomUUID } from "node:crypto";
import { chat } from "./llm.js";
import { ProspectService } from "./ProspectService.js";
import { DEFAULT_CATS, resolveCategories, resolveGoogleTypes } from "./prospectCategories.js";
import { GooglePlacesService, type DiscoveryResult } from "./GooglePlacesService.js";

/**
 * Prospect AI — DESCOBERTA AUTOMÁTICA por região (Fase 2).
 *
 * A IA encontra empresas dentro de um RAIO a partir de um ponto de referência
 * (endereço/CEP), usando SOMENTE fontes públicas/abertas — sem scraping:
 *   • Geocodificação: Nominatim (OpenStreetMap).
 *   • Empresas: Overpass API (OpenStreetMap) — POIs comerciais na área.
 *
 * O fluxo noturno (Scheduler, 19h–6h, a cada ~3h) varre a área, cria contas
 * novas (3–10 por rodada), registra SINAIS OBSERVÁVEIS e o "Maestro" dá
 * sequência (hipóteses de dor + score). Nada é enviado: tudo para na revisão
 * humana com um RESUMO da rodada.
 */

const UA = "ZapFlow.ai Prospect Discovery (contato@zapflow.ai)";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const MAX_PER_RUN = 10;        // teto de contas novas por rodada
const MIN_GAP_HOURS = 3;       // intervalo mínimo entre rodadas da mesma campanha


function normName(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(ltda|me|eireli|s\.?a\.?|epp|cia|company|inc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function normDomain(v: any): string {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0].trim();
  return s.includes(".") ? s : "";
}
function onlyDigits(v: any): string { return String(v || "").replace(/\D+/g, ""); }

async function httpJson(url: string, opts: { method?: string; body?: string; timeoutMs?: number } = {}): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20000);
  try {
    const r = await fetch(url, {
      method: opts.method || "GET",
      headers: { "User-Agent": UA, "Accept": "application/json", ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: opts.body, signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Resultado de descoberta (OSM ou Google Places) — tipo comum em GooglePlacesService.
export type { DiscoveryResult };

export class ProspectDiscoveryService {
  /** Janela noturna ativa? (19h às 6h, horário de Brasília). */
  static nightWindowActive(brtHour: number): boolean {
    return brtHour >= 19 || brtHour < 6;
  }
  static brtHour(nowMs: number): number {
    return parseInt(new Date(nowMs).toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour12: false, hour: "2-digit" }), 10) || 0;
  }

  /** Extrai um CEP (8 dígitos) de um texto livre, se houver. */
  static extractCep(s: string): string {
    const m = String(s || "").match(/(\d{5})-?\s?(\d{3})/);
    return m ? `${m[1]}${m[2]}` : "";
  }
  /** Limpa endereço digitado à mão (separadores soltos, "en/in", barras). */
  static cleanAddress(s: string): string {
    return String(s || "")
      .replace(/[;|/]+/g, ", ")
      .replace(/\b(en|in)\b/gi, ", ")
      .replace(/\s*,\s*/g, ", ")
      .replace(/(,\s*)+/g, ", ")
      .replace(/\s+/g, " ")
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
  }
  /** Uma consulta livre ao Nominatim (Brasil). */
  static async nominatim(q: string): Promise<{ lat: number; lon: number; display: string } | null> {
    if (!q) return null;
    const url = `${NOMINATIM}?format=json&limit=1&countrycodes=br&addressdetails=0&q=${encodeURIComponent(q)}`;
    const arr = await httpJson(url);
    const hit = Array.isArray(arr) ? arr[0] : null;
    if (!hit?.lat || !hit?.lon) return null;
    return { lat: Number(hit.lat), lon: Number(hit.lon), display: String(hit.display_name || q) };
  }
  /** Resolve um CEP via ViaCEP → endereço estruturado → coordenadas. */
  static async geocodeViaCep(cep: string): Promise<{ lat: number; lon: number; display: string } | null> {
    try {
      const v = await httpJson(`https://viacep.com.br/ws/${cep}/json/`);
      if (!v || v.erro) return null;
      const addr = [v.logradouro, v.bairro, v.localidade, v.uf].filter(Boolean).join(", ");
      return addr ? await this.nominatim(addr) : null;
    } catch { return null; }
  }

  /**
   * Geocodifica endereço/CEP → {lat, lon}. Tolerante a texto digitado à mão:
   * tenta a string limpa; depois resolve pelo CEP (ViaCEP → Nominatim); por fim,
   * tenta só o texto sem o CEP. Brasil (Nominatim countrycodes=br).
   */
  static async geocode(address: string): Promise<{ lat: number; lon: number; display: string } | null> {
    const raw = String(address || "").trim();
    if (!raw) return null;
    const cleaned = this.cleanAddress(raw);
    let hit = await this.nominatim(cleaned).catch(() => null);
    if (hit) return hit;
    const cep = this.extractCep(raw);
    if (cep) {
      hit = await this.geocodeViaCep(cep);
      if (hit) return hit;
      hit = await this.nominatim(`${cep.slice(0, 5)}-${cep.slice(5)}`).catch(() => null);
      if (hit) return hit;
      const noCep = this.cleanAddress(raw.replace(/\d{5}-?\s?\d{3}/, ""));
      if (noCep) { hit = await this.nominatim(noCep).catch(() => null); if (hit) return hit; }
    }
    return null;
  }

  // Tradução PT-BR → etiquetas OSM (fonte única em prospectCategories).
  static resolveCategories(raw: string): string[] { return resolveCategories(raw); }

  /**
   * Categorias efetivas da campanha: usa o campo "Tipo de negócio" se houver;
   * senão DERIVA do ICP (vertical / nome / sinais) — assim uma campanha de
   * "clínicas" busca clínicas sem o usuário digitar nada. Vazio = padrão amplo.
   */
  static categoriesForCampaign(camp: any): string[] {
    const explicit = resolveCategories(camp?.discovery_categories || "");
    if (explicit.length) return explicit;
    if (camp?.icp_id) {
      const icp = db.prepare("SELECT name, vertical, criteria_json FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(camp.icp_id, camp.organization_id) as any;
      if (icp) {
        let crit: any = {}; try { crit = JSON.parse(icp.criteria_json || "{}"); } catch { /* ignora */ }
        const terms = [icp.vertical, icp.name, crit?.segmento, crit?.sinais].filter(Boolean).join(", ");
        const derived = resolveCategories(terms);
        if (derived.length) return derived;
      }
    }
    return [];
  }

  /** Tipos do Google Places para a campanha (campo explícito → senão ICP). Vazio = amplo. */
  static googleTypesForCampaign(camp: any): string[] {
    const explicit = resolveGoogleTypes(camp?.discovery_categories || "");
    if (explicit.length) return explicit;
    if (camp?.icp_id) {
      const icp = db.prepare("SELECT name, vertical, criteria_json FROM prospect_icp_profiles WHERE id = ? AND organization_id = ?").get(camp.icp_id, camp.organization_id) as any;
      if (icp) {
        let crit: any = {}; try { crit = JSON.parse(icp.criteria_json || "{}"); } catch { /* ignora */ }
        const derived = resolveGoogleTypes([icp.vertical, icp.name, crit?.segmento, crit?.sinais].filter(Boolean).join(", "));
        if (derived.length) return derived;
      }
    }
    return [];
  }

  // ── Chave da Google Places API (premium), por organização ────────────────
  static placesKey(orgId: string): string {
    const row = db.prepare("SELECT prospect_places_api_key FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    return String(row?.prospect_places_api_key || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "").trim();
  }
  static setPlacesKey(orgId: string, key: string): { configured: boolean } {
    const k = String(key || "").trim();
    db.prepare("UPDATE organization_settings SET prospect_places_api_key = ? WHERE organization_id = ?").run(k || null, orgId);
    return { configured: !!k };
  }
  /** Status da chave (sem expor o valor): configurada? dica do final? veio do ambiente? */
  static getPlacesKeyInfo(orgId: string): { configured: boolean; hint: string; fromEnv: boolean } {
    const row = db.prepare("SELECT prospect_places_api_key FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    const orgKey = String(row?.prospect_places_api_key || "").trim();
    const envKey = String(process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "").trim();
    const key = orgKey || envKey;
    return { configured: !!key, hint: key ? `…${key.slice(-4)}` : "", fromEnv: !orgKey && !!envKey };
  }

  static buildOverpass(lat: number, lon: number, radiusKm: number, categories: string[]): string {
    const r = Math.max(50, Math.round((Number(radiusKm) || 1) * 1000));
    const cats = categories.length ? categories : DEFAULT_CATS;
    const clauses = cats.flatMap(c => {
      const sel = c.includes("=") ? `["${c.split("=")[0]}"="${c.split("=").slice(1).join("=")}"]` : `["${c}"]`;
      return [`node(around:${r},${lat},${lon})${sel};`, `way(around:${r},${lat},${lon})${sel};`];
    }).join("");
    return `[out:json][timeout:25];(${clauses});out center tags 150;`;
  }

  static parseOsm(json: any): DiscoveryResult[] {
    const out: DiscoveryResult[] = [];
    const seen = new Set<string>();
    for (const el of (json?.elements || [])) {
      const t = el?.tags || {};
      const name = String(t.name || "").trim();
      if (!name) continue;
      const key = normName(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        osmRef: `${el.type}/${el.id}`,
        segment: String(t.shop || t.office || t.craft || t.amenity || "").replace(/_/g, " ").trim(),
        phone: String(t.phone || t["contact:phone"] || "").trim(),
        website: String(t.website || t["contact:website"] || "").trim(),
        street: [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(", "),
        city: String(t["addr:city"] || "").trim(),
        state: String(t["addr:state"] || "").trim(),
        lat: el.lat ?? el.center?.lat,
        lon: el.lon ?? el.center?.lon,
      });
    }
    return out;
  }

  /** Busca empresas na área (Overpass). Pode ser substituída em testes. */
  static async searchOSM(lat: number, lon: number, radiusKm: number, categories: string[]): Promise<DiscoveryResult[]> {
    const query = this.buildOverpass(lat, lon, radiusKm, categories);
    const json = await httpJson(OVERPASS, { method: "POST", body: "data=" + encodeURIComponent(query), timeoutMs: 30000 });
    return this.parseOsm(json);
  }

  /**
   * Cria contas a partir dos resultados (dedup por OSM id / nome), até MAX_PER_RUN.
   * Registra sinais observáveis e (quando há) contato com telefone.
   */
  static createFromResults(orgId: string, campaign: any, results: DiscoveryResult[], sourceId: string, provider = "osm_overpass"): { created: number; skipped: number; accountIds: string[] } {
    const findByRef = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND external_ref = ?");
    const findByName = db.prepare("SELECT id FROM prospect_accounts WHERE organization_id = ? AND dedupe_key = ?");
    const insAcc = db.prepare(`INSERT INTO prospect_accounts (id, organization_id, campaign_id, display_name, domain, website_url, industry, city, state, source_id, source, account_status, dedupe_key, external_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)`);
    const insSig = db.prepare(`INSERT INTO prospect_signals (id, organization_id, prospect_account_id, signal_type, observation, evidence_reference, confidence, source_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'connector')`);
    const insContact = db.prepare(`INSERT INTO prospect_contacts (id, organization_id, prospect_account_id, full_name, role_title, email, email_status, phone, source_id, confidence) VALUES (?, ?, ?, NULL, NULL, '', 'unknown', ?, ?, 0.5)`);

    let created = 0, skipped = 0;
    const accountIds: string[] = [];
    const areaLabel = `${campaign.discovery_address || "área"} (raio ${campaign.discovery_radius_km || 1} km)`;
    const tx = db.transaction(() => {
      for (const r of results) {
        if (created >= MAX_PER_RUN) break;
        const key = normName(r.name);
        if (!key) { skipped++; continue; }
        if ((findByRef.get(orgId, r.osmRef) as any) || (findByName.get(orgId, key) as any)) { skipped++; continue; }
        const accId = randomUUID();
        const domain = normDomain(r.website);
        const ref = r.osmRef;
        insAcc.run(accId, orgId, campaign.id, r.name, domain || null, r.website || null, r.segment || null, r.city || null, r.state || null, sourceId, provider, key, ref);
        // Sinal-base (sempre): garante ≥1 evidência para gerar hipóteses.
        insSig.run(randomUUID(), orgId, accId, "outro", `Empresa encontrada na varredura de ${areaLabel}${r.segment ? ` — segmento: ${r.segment}` : ""}.`, ref, 0.6);
        // Avaliações públicas (Google Places): viram sinal de reputação/dor.
        if (typeof r.rating === "number") {
          const rc = r.ratingCount || 0;
          if (r.rating < 4.0) insSig.run(randomUUID(), orgId, accId, "resposta_comercial", `Reputação a melhorar: ${r.rating.toFixed(1)}★ em ${rc} avaliação(ões) públicas — oportunidade de atendimento.`, ref, 0.7);
          else insSig.run(randomUUID(), orgId, accId, "outro", `Reputação pública: ${r.rating.toFixed(1)}★ (${rc} avaliações).`, ref, 0.5);
        }
        if (!r.website) insSig.run(randomUUID(), orgId, accId, "cobertura_digital", "Sem site informado na fonte pública (possível baixa presença digital).", ref, 0.5);
        if (!r.phone) insSig.run(randomUUID(), orgId, accId, "resposta_comercial", "Sem telefone público listado (canal de contato a confirmar).", ref, 0.5);
        if (r.phone) insContact.run(randomUUID(), orgId, accId, onlyDigits(r.phone), sourceId);
        accountIds.push(accId);
        created++;
      }
    });
    tx();
    return { created, skipped, accountIds };
  }

  /**
   * "Maestro": dá sequência ao fluxo nas contas novas (hipóteses + score). Com
   * `autodraft` (opt-in da campanha), também prepara um rascunho de abordagem
   * para contas COM contato e bom encaixe, deixando-o na FILA DE APROVAÇÃO —
   * nada é enviado: o humano aprova. Tudo best-effort (uma falha não derruba a rodada).
   */
  static async orchestrate(orgId: string, accountIds: string[], opts: { autodraft?: boolean } = {}): Promise<void> {
    for (const id of accountIds) {
      try { await ProspectService.generateHypotheses(orgId, id); } catch (e) { /* segue */ }
      let score: any = null;
      try { score = ProspectService.computeScore(orgId, id); } catch (e) { /* segue */ }
      if (opts.autodraft && score && score.priority >= 40) {
        try {
          const acc = ProspectService.getAccount(orgId, id);
          const contact = (acc?.contacts || []).find((c: any) => c.email || c.phone);
          if (contact) {
            const channel = contact.email ? "email" : "whatsapp";
            const updated = await ProspectService.composeOutreach(orgId, id, { contactId: contact.id, channel });
            const draft = (updated?.outreach || []).find((o: any) => o.status === "draft");
            if (draft) ProspectService.setOutreachStatus(orgId, draft.id, "pending_approval");
          }
        } catch (e) { /* segue */ }
      }
    }
  }

  static async summarize(area: string, created: number, results: DiscoveryResult[]): Promise<string> {
    if (!created) return `Varri ${area} e não encontrei empresas novas nesta rodada.`;
    const nomes = results.slice(0, created).map(r => r.name).join(", ");
    try {
      const prompt = `Resuma em 2 frases curtas, em português do Brasil, uma rodada de prospecção automática. Área: ${area}. ${created} empresa(s) nova(s) encontrada(s): ${nomes}. Diga o que foi feito e que aguarda revisão humana. Não invente dados.`;
      const s = (await chat(prompt, { temperature: 0.4 })).trim();
      if (s) return s;
    } catch (e) { /* fallback abaixo */ }
    return `Encontrei ${created} empresa(s) nova(s) em ${area}. Hipóteses e score gerados; aguardando sua revisão.`;
  }

  /** Roda a descoberta de UMA campanha (geocode → busca → cria → orquestra → resumo). */
  static async runForCampaign(orgId: string, campaignId: string, trigger: "manual" | "scheduler" = "manual"): Promise<any> {
    const camp = db.prepare("SELECT * FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(campaignId, orgId) as any;
    if (!camp) throw new Error("Campanha não encontrada.");
    if (!camp.discovery_address) throw new Error("Defina um endereço/CEP de referência na campanha.");
    const runId = randomUUID();
    const area = `${camp.discovery_address} (raio ${camp.discovery_radius_km || 1} km)`;
    db.prepare("INSERT INTO prospect_discovery_runs (id, organization_id, campaign_id, area, status, trigger) VALUES (?, ?, ?, ?, 'running', ?)").run(runId, orgId, campaignId, area, trigger);
    try {
      let lat = camp.discovery_lat, lon = camp.discovery_lon;
      if (lat == null || lon == null) {
        const geo = await this.geocode(camp.discovery_address);
        if (!geo) throw new Error("Não localizei o endereço/CEP. Tente algo como 'Rua Conde de Bonfim, Tijuca, Rio de Janeiro - RJ' ou só o CEP (ex.: 20530-000).");
        lat = geo.lat; lon = geo.lon;
        db.prepare("UPDATE prospect_campaigns SET discovery_lat = ?, discovery_lon = ? WHERE id = ? AND organization_id = ?").run(lat, lon, campaignId, orgId);
      }
      const useGoogle = camp.discovery_source === "google_places";
      let results: DiscoveryResult[];
      const provider = useGoogle ? "google_places" : "osm_overpass";
      if (useGoogle) {
        const key = this.placesKey(orgId);
        if (!key) throw new Error("Fonte Premium selecionada, mas falta a chave da Google Places API. Configure-a na campanha (Descoberta).");
        results = await GooglePlacesService.searchNearby(lat, lon, camp.discovery_radius_km || 1, this.googleTypesForCampaign(camp), key);
      } else {
        results = await this.searchOSM(lat, lon, camp.discovery_radius_km || 1, this.categoriesForCampaign(camp));
      }
      const srcId = randomUUID();
      db.prepare("INSERT INTO prospect_data_sources (id, organization_id, provider, source_reference, terms_profile, retention_policy, confidence) VALUES (?, ?, ?, ?, ?, 'tenant_policy', ?)")
        .run(srcId, orgId, provider, area, useGoogle ? "licensed" : "public", useGoogle ? 0.85 : 0.6);
      const { created, skipped, accountIds } = this.createFromResults(orgId, camp, results, srcId, provider);
      await this.orchestrate(orgId, accountIds, { autodraft: !!camp.discovery_autodraft });
      const summary = await this.summarize(area, created, results);
      db.prepare("UPDATE prospect_discovery_runs SET status = 'done', found_count = ?, created_count = ?, skipped_count = ?, summary = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(results.length, created, skipped, summary, runId);
      db.prepare("UPDATE prospect_campaigns SET discovery_last_run = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(campaignId, orgId);
      return db.prepare("SELECT * FROM prospect_discovery_runs WHERE id = ?").get(runId);
    } catch (e: any) {
      db.prepare("UPDATE prospect_discovery_runs SET status = 'error', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?").run(String(e?.message || e), runId);
      throw e;
    }
  }

  /** Scheduler: roda campanhas elegíveis (descoberta ON, janela noturna, gap ≥ 3h). */
  static async runDue(nowMs = Date.now()): Promise<{ ran: number }> {
    if (!this.nightWindowActive(this.brtHour(nowMs))) return { ran: 0 };
    const due = db.prepare(`
      SELECT id, organization_id FROM prospect_campaigns
      WHERE discovery_enabled = 1 AND status != 'archived'
        AND discovery_address IS NOT NULL AND discovery_address != ''
        AND (discovery_last_run IS NULL OR discovery_last_run <= datetime('now', ?))
      LIMIT 50
    `).all(`-${MIN_GAP_HOURS} hours`) as any[];
    let ran = 0;
    for (const c of due) {
      try { await this.runForCampaign(c.organization_id, c.id, "scheduler"); ran++; }
      catch (e) { console.error("[Discovery] campanha", c.id, "falhou:", e); }
    }
    return { ran };
  }

  /** Config da descoberta na campanha (regeocodifica se o endereço mudar). */
  static async updateConfig(orgId: string, campaignId: string, patch: any): Promise<any> {
    const camp = db.prepare("SELECT discovery_address FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(campaignId, orgId) as any;
    if (!camp) throw new Error("Campanha não encontrada.");
    const fields: string[] = [], params: any[] = [];
    if (patch.discoveryEnabled !== undefined) { fields.push("discovery_enabled = ?"); params.push(patch.discoveryEnabled ? 1 : 0); }
    if (patch.address !== undefined) {
      const addr = String(patch.address || "").trim();
      fields.push("discovery_address = ?", "discovery_lat = NULL", "discovery_lon = NULL"); params.push(addr || null);
    }
    if (patch.radiusKm !== undefined) { fields.push("discovery_radius_km = ?"); params.push(Math.max(0.1, Math.min(25, Number(patch.radiusKm) || 1))); }
    if (patch.categories !== undefined) { fields.push("discovery_categories = ?"); params.push(String(patch.categories || "").trim() || null); }
    if (patch.source !== undefined) { fields.push("discovery_source = ?"); params.push(patch.source === "google_places" ? "google_places" : "osm"); }
    if (patch.autodraft !== undefined) { fields.push("discovery_autodraft = ?"); params.push(patch.autodraft ? 1 : 0); }
    if (fields.length) { params.push(campaignId, orgId); db.prepare(`UPDATE prospect_campaigns SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params); }
    return db.prepare("SELECT * FROM prospect_campaigns WHERE id = ? AND organization_id = ?").get(campaignId, orgId);
  }

  static listRuns(orgId: string, campaignId?: string): any[] {
    if (campaignId) return db.prepare("SELECT * FROM prospect_discovery_runs WHERE organization_id = ? AND campaign_id = ? ORDER BY started_at DESC LIMIT 50").all(orgId, campaignId) as any[];
    return db.prepare("SELECT * FROM prospect_discovery_runs WHERE organization_id = ? ORDER BY started_at DESC LIMIT 50").all(orgId) as any[];
  }
}
