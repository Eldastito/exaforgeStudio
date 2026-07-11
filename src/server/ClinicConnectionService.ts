import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * Módulo Clínica — Onboarding de Conexão TISS (ADR-081, Fase F0).
 *
 * A clínica preenche o questionário no próprio sistema; aqui guardamos as
 * respostas (perfil da org + prontidão por operadora) e CALCULAMOS a prontidão
 * — quais itens BLOQUEANTES faltam e até onde a conexão pode ir. É o passo que
 * "automatiza receber as informações" e diz, por operadora, se dá para
 * homologar já, se falta dado, ou se só resta o modo manual (certificado A3).
 *
 * Nada aqui envia guia nem conecta de fato — isso é F1/F2 (conectores). É o
 * mapa de prontidão que antecede a implementação, disparada por operadora real.
 */
const CERT_TYPES = ["unknown", "none", "a1", "a3"];

export class ClinicConnectionService {
  // ── Perfil de conexão (nível da organização) ─────────────────────────────
  static getProfile(orgId: string): any {
    const p = db.prepare("SELECT * FROM clinic_connection_profile WHERE organization_id = ?").get(orgId) as any;
    return p || { organization_id: orgId, certificate_type: "unknown" };
  }

  static saveProfile(orgId: string, input: {
    legalName?: string; cnpj?: string; cnes?: string; certificateType?: string; certificateValidUntil?: string;
    responsibleName?: string; responsibleRegistry?: string; monthlyAuthorizations?: number; notes?: string;
  }, actorId?: string): any {
    const certType = CERT_TYPES.includes(String(input?.certificateType)) ? input!.certificateType : undefined;
    const existing = db.prepare("SELECT id FROM clinic_connection_profile WHERE organization_id = ?").get(orgId) as any;
    if (!existing) {
      db.prepare(`INSERT INTO clinic_connection_profile (id, organization_id, legal_name, cnpj, cnes, certificate_type, certificate_valid_until, responsible_name, responsible_registry, monthly_authorizations, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, s(input?.legalName), digits(input?.cnpj), s(input?.cnes), certType || "unknown", input?.certificateValidUntil || null,
          s(input?.responsibleName), s(input?.responsibleRegistry), int(input?.monthlyAuthorizations), s(input?.notes));
    } else {
      const fields: string[] = [], params: any[] = [];
      const set = (c: string, v: any) => { fields.push(`${c} = ?`); params.push(v); };
      if (input.legalName !== undefined) set("legal_name", s(input.legalName));
      if (input.cnpj !== undefined) set("cnpj", digits(input.cnpj));
      if (input.cnes !== undefined) set("cnes", s(input.cnes));
      if (certType !== undefined) set("certificate_type", certType);
      if (input.certificateValidUntil !== undefined) set("certificate_valid_until", input.certificateValidUntil || null);
      if (input.responsibleName !== undefined) set("responsible_name", s(input.responsibleName));
      if (input.responsibleRegistry !== undefined) set("responsible_registry", s(input.responsibleRegistry));
      if (input.monthlyAuthorizations !== undefined) set("monthly_authorizations", int(input.monthlyAuthorizations));
      if (input.notes !== undefined) set("notes", s(input.notes));
      if (fields.length) { params.push(orgId); db.prepare(`UPDATE clinic_connection_profile SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(...params); }
    }
    logAuthEvent(orgId, actorId, null, "CLINIC_CONNECTION_PROFILE_SAVED", { certificateType: certType });
    return this.getProfile(orgId);
  }

  // ── Prontidão por operadora (respostas do questionário) ──────────────────
  static setOperatorReadiness(orgId: string, operatorId: string, input: {
    credentialed?: boolean; providerCode?: string; hasHomologAccess?: boolean; tissVersion?: string;
    acceptsWebservice?: boolean; monthlyVolume?: number; unimedSingular?: string;
  }, actorId?: string): any {
    const op = db.prepare("SELECT id FROM health_plan_operators WHERE id = ? AND organization_id = ?").get(operatorId, orgId);
    if (!op) throw new Error("Operadora não encontrada.");
    const fields: string[] = [], params: any[] = [];
    const set = (c: string, v: any) => { fields.push(`${c} = ?`); params.push(v); };
    if (input.credentialed !== undefined) set("credentialed", input.credentialed ? 1 : 0);
    if (input.providerCode !== undefined) set("provider_code", s(input.providerCode));
    if (input.hasHomologAccess !== undefined) set("has_homolog_access", input.hasHomologAccess ? 1 : 0);
    if (input.tissVersion !== undefined) set("tiss_version", s(input.tissVersion));
    if (input.acceptsWebservice !== undefined) set("accepts_webservice", input.acceptsWebservice ? 1 : 0);
    if (input.monthlyVolume !== undefined) set("monthly_volume", int(input.monthlyVolume));
    if (input.unimedSingular !== undefined) set("unimed_singular", s(input.unimedSingular));
    if (fields.length) { params.push(operatorId, orgId); db.prepare(`UPDATE health_plan_operators SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(...params); }
    logAuthEvent(orgId, actorId, null, "CLINIC_OPERATOR_READINESS_SAVED", { operatorId });
    return db.prepare("SELECT * FROM health_plan_operators WHERE id = ?").get(operatorId);
  }

  /**
   * Mapa de PRONTIDÃO: perfil da org + cada operadora, com os itens que faltam
   * e o status. É o resultado "automatizado" do questionário.
   *
   * Status por operadora:
   *  - blocked_certificate: sem A1 (A3/none/desconhecido) → só modo MANUAL;
   *  - gathering: faltam itens bloqueantes;
   *  - ready_to_homologate: tudo presente → pode iniciar F1 com esta operadora;
   *  - connected: connector_type != manual (já ligado — futuro).
   * connectionCeiling: até onde dá para automatizar HOJE, dado o que a operadora
   * aceita (manual / signed_xml (Nível 2) / webservice (Nível 3)).
   */
  static readiness(orgId: string): any {
    const p = this.getProfile(orgId);
    // Itens bloqueantes de NÍVEL ORG (valem para qualquer operadora):
    const orgBlocking: string[] = [];
    if (p.certificate_type !== "a1") orgBlocking.push(p.certificate_type === "a3" ? "Certificado é A3 (token/cartão) — não suportado no MVP; use A1 (arquivo) ou siga no modo manual" : "Certificado digital A1 (arquivo .pfx/.p12) não informado");
    if (!p.cnes) orgBlocking.push("CNES da clínica não informado");
    if (!p.responsible_registry) orgBlocking.push("Registro do profissional responsável (conselho/UF) não informado");

    const operators = db.prepare("SELECT * FROM health_plan_operators WHERE organization_id = ? AND active = 1 ORDER BY name").all(orgId) as any[];
    const perOperator = operators.map((o: any) => {
      const missing: string[] = [];
      if (!o.credentialed) missing.push("Clínica não marcada como credenciada nesta operadora");
      if (!o.provider_code) missing.push("Código do prestador não informado");
      if (!o.has_homolog_access) missing.push("Sem acesso ao ambiente de homologação da operadora");
      if (!o.tiss_version) missing.push("Versão TISS aceita pela operadora não informada");
      // Credenciais são gravadas cifradas na Fase E (health_plan_credentials).
      const cred = db.prepare("SELECT username_encrypted FROM health_plan_credentials WHERE organization_id = ? AND operator_id = ?").get(orgId, o.id) as any;
      if (!cred?.username_encrypted) missing.push("Credenciais de acesso (portal/WebService) não configuradas");

      let status: string;
      const certBlocked = p.certificate_type !== "a1";
      if (certBlocked) status = "blocked_certificate";
      else if (orgBlocking.length > (certBlocked ? 1 : 0) || missing.length) status = "gathering";
      else status = "ready_to_homologate";
      if (o.connector_type && o.connector_type !== "manual") status = "connected";

      const ceiling = certBlocked ? "manual" : (o.accepts_webservice ? "webservice" : "signed_xml");
      return {
        id: o.id, name: o.name, unimed_singular: o.unimed_singular || null,
        credentialed: !!o.credentialed, has_homolog_access: !!o.has_homolog_access,
        tiss_version: o.tiss_version || null, accepts_webservice: !!o.accepts_webservice,
        connector_type: o.connector_type || "manual",
        status, connectionCeiling: ceiling,
        missing: [...(certBlocked ? [] : orgBlocking), ...missing], // sem A1, o bloqueio-mãe é o certificado
      };
    });

    const readyCount = perOperator.filter(o => o.status === "ready_to_homologate").length;
    return {
      profile: p,
      orgBlocking,
      operators: perOperator,
      summary: {
        operators: operators.length,
        readyToHomologate: readyCount,
        blockedByCertificate: perOperator.filter(o => o.status === "blocked_certificate").length,
        // Sugestão de piloto: a pronta de maior volume.
        suggestedPilot: perOperator.filter(o => o.status === "ready_to_homologate")
          .map(o => ({ id: o.id, name: o.name, volume: operators.find(x => x.id === o.id)?.monthly_volume || 0 }))
          .sort((a, b) => b.volume - a.volume)[0] || null,
      },
    };
  }
}

function s(v: any): string | null { const t = String(v ?? "").trim(); return t || null; }
function digits(v: any): string | null { const t = String(v ?? "").replace(/\D/g, ""); return t || null; }
function int(v: any): number | null { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : null; }
