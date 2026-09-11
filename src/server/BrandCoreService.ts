import db from "./db.js";
import { randomUUID } from "node:crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * BrandCoreService — PRD 01 "Brand Core" (roadmap Evolução de Marca do ZapFlow).
 *
 * FONTE ÚNICA DE VERDADE da marca INSTITUCIONAL do ZapFlow (a marca da PLATAFORMA —
 * quem o ZapFlow é, para quem existe, qual problema combate, qual transformação promete).
 * NÃO confundir com a marca do TENANT (`BrandDnaService`/ADR-168, por-org): esta é única,
 * GLOBAL, escopo plataforma, editável só pelo Admin Master.
 *
 * DECISÕES DE ARQUITETURA (Fase 0 — docs/prd/ANALISE-PRD-BRAND-EVOLUTION-vs-CODEBASE.md):
 *  - O PRD assume Postgres/Supabase/RLS; o ZapFlow é SQLite + Express. "RLS" relê-se como
 *    escopo GLOBAL (`brand_core_versions`, sem organization_id) + rotas `requireMasterAdmin`
 *    + teste de isolamento (tenant não lê/escreve). Nenhuma linha de RLS/Supabase criada.
 *  - COMPÕE padrões provados, sem inventar: versionamento/snapshot canônico espelha
 *    `brand_dna_versions` (ADR-168); auditoria via `logAuthEvent`; RBAC via requireMasterAdmin
 *    do mount `/api/admin`. NÃO cria 2º sistema de config/versionamento/auditoria.
 *  - IA sugere / humano publica: o seed nasce DRAFT e NUNCA publica sozinho (§43).
 *
 * INVARIANTES:
 *  - Só existe UMA versão `published` ativa; publicar arquiva a anterior (nunca apaga).
 *  - Só existe UM `draft` por vez (single-draft) — createDraft devolve o existente.
 *  - Versão publicada é IMUTÁVEL: editar = criar draft → publicar nova versão.
 *  - Restore = novo DRAFT a partir de versão antiga (nunca sobrescreve histórico).
 *  - Concorrência: `revision` no draft; update/publish exigem a revisão esperada (nunca
 *    sobrescreve silenciosamente — conflito explícito).
 *  - Nunca inventa: sem versão publicada → getPublished() devolve {status:'not_configured'}.
 */

export type BrandCoreStatus = "draft" | "published" | "archived";

export interface MechanismStep { key: string; label: string; order: number }

// PRD 02 — Identidade Verbal / Message House. ESTENDE o Brand Core (mesmo snapshot/versão,
// sem store novo). NÃO duplica os claims proibidos: eles seguem em `restrictedClaims` (o
// resolver `getBrandMessaging` os expõe como `prohibitedClaims`). A hierarquia
// transformação→mecanismo→benefícios já vive nos campos do Brand Core (PRD 01).
export interface BrandMessaging {
  masterMessage: string | null;       // mensagem-mãe (transformação, não funcionalidade)
  tagline: string | null;
  elevatorPitch: string | null;
  shortDescription: string | null;
  mediumDescription: string | null;
  longDescription: string | null;
  functionalMessages: string[];       // como DIZER os benefícios funcionais
  emotionalMessages: string[];
  objectionResponses: { objection: string; response: string }[];
  vocabulary: string[];               // termos recomendados
  discouragedTerms: string[];         // termos a evitar (não são claims proibidos)
  toneOfVoice: string | null;
}

export interface BrandCoreSnapshot {
  essence: string | null;
  purpose: string | null;
  category: string | null;
  positioning: string | null;
  promise: string | null;
  coreProblem: string | null;
  coreProblemManifestations: string[];
  enemy: string | null;
  targetAudience: { primary: string[] };
  transformation: { before: string[]; after: string[] };
  mechanism: { steps: MechanismStep[] };
  brandAttributes: string[];
  functionalBenefits: string[];
  emotionalBenefits: string[];
  differentiators: Array<{ title: string; description: string }>;
  proofPoints: any[];
  approvedClaims: string[];
  restrictedClaims: string[];
  messaging: BrandMessaging;
}

const PLATFORM = "platform"; // escopo de auditoria (Brand Core é global, sem org de tenant)

// Campos obrigatórios pra PUBLICAR (§36). transformation/mechanism validados à parte (arrays).
const REQUIRED_TEXT: (keyof BrandCoreSnapshot)[] = ["essence", "purpose", "category", "positioning", "promise", "coreProblem"];

function str(v: any): string | null { const s = v == null ? "" : String(v).trim(); return s ? s : null; }
function arr(v: any): any[] { return Array.isArray(v) ? v : []; }
function strArr(v: any): string[] { return arr(v).map((x) => String(x).trim()).filter(Boolean); }

// Message house vazia — usada quando um snapshot antigo (pré-PRD 02) não tem `messaging`
// (0-regressão: versões publicadas antes da message house normalizam para vazio).
function emptyMessaging(): BrandMessaging {
  return {
    masterMessage: null, tagline: null, elevatorPitch: null,
    shortDescription: null, mediumDescription: null, longDescription: null,
    functionalMessages: [], emotionalMessages: [], objectionResponses: [],
    vocabulary: [], discouragedTerms: [], toneOfVoice: null,
  };
}

/** Draft estratégico inicial (§9-§24). Nasce DRAFT, jamais publicado automaticamente. */
export function brandCoreDefaults(): BrandCoreSnapshot {
  return {
    essence: "Fazer empresas funcionarem melhor e dependerem menos do empresário para tudo.",
    purpose: "Ajudar empresas a transformar conhecimento, informação e intenção em execução organizada e inteligente.",
    category: "Sistema Operacional Inteligente para Empresas",
    positioning: "O ZapFlow conecta inteligência, operação e execução para ajudar empresas a funcionar de forma mais organizada, previsível e menos dependente do proprietário ou de pessoas-chave.",
    promise: "Sua empresa funcionando, mesmo quando você não está olhando.",
    coreProblem: "Dependência operacional",
    coreProblemManifestations: [
      "dependência do proprietário", "dependência de funcionários-chave", "dependência da memória",
      "dependência de processos manuais", "dependência de planilhas", "dependência de WhatsApp",
      "dependência de conhecimento informal", "dependência de acompanhamento humano", "dependência de cobrança manual",
    ],
    enemy: "Caos operacional, dependência excessiva e informação que não vira execução.",
    targetAudience: { primary: ["PMEs", "empresários", "gestores", "autônomos com operação crescente"] },
    transformation: {
      before: ["Informação espalhada", "Pessoas precisam lembrar", "Gestor precisa cobrar", "Problemas descobertos tarde", "Empresário apaga incêndios"],
      after: ["Informação conectada", "Sistema identifica contexto", "Organiza a necessidade", "Aciona a execução", "Acompanha", "Aprende"],
    },
    mechanism: {
      steps: [
        { key: "observe", label: "Observa", order: 1 }, { key: "understand", label: "Entende", order: 2 },
        { key: "organize", label: "Organiza", order: 3 }, { key: "act", label: "Age", order: 4 },
        { key: "follow", label: "Acompanha", order: 5 }, { key: "learn", label: "Aprende", order: 6 },
      ],
    },
    brandAttributes: [],
    functionalBenefits: [
      "mais organização", "mais controle", "mais execução", "mais previsibilidade",
      "redução de tarefas esquecidas", "redução da dependência de pessoas", "mais automação",
      "melhor acompanhamento", "melhor aproveitamento das informações", "recuperação de oportunidades", "economia de tempo",
    ],
    emotionalBenefits: ["tranquilidade", "controle", "segurança operacional", "clareza", "confiança para delegar", "menos sensação de apagar incêndios"],
    differentiators: [
      { title: "Inteligência integrada à execução", description: "Não apenas responde — pode transformar contexto em ação dentro da operação." },
      { title: "Conhecimento contínuo da empresa", description: "Compreende o contexto empresarial progressivamente." },
      { title: "Visão transversal", description: "Comercial, operação, atendimento e gestão trabalham conectados." },
      { title: "Humanização", description: "Automação não significa relacionamento mecânico." },
      { title: "Ação contextual", description: "Considera empresa, usuário, cliente, processo, histórico, permissão e situação." },
    ],
    proofPoints: [],       // vazio até revisão (§22)
    approvedClaims: [],    // vazio até revisão (§23)
    restrictedClaims: [    // guardrails (§24) — claims que exigem evidência / proibidos
      "Elimina todos os erros.", "Substitui completamente funcionários.", "Funciona sozinho em qualquer empresa.",
      "Garante aumento de faturamento.", "Garante redução de X%.", "É o melhor sistema do Brasil.",
    ],
    messaging: {
      masterMessage: "Sua empresa menos dependente de você e mais inteligente no dia a dia.",
      tagline: "Sua empresa funcionando, mesmo quando você não está olhando.",
      elevatorPitch: "O ZapFlow observa, entende, organiza, age, acompanha e aprende — para a empresa funcionar sem depender do dono, da memória e de processos manuais.",
      shortDescription: "Sistema operacional inteligente que reduz a dependência da sua empresa em relação ao dono e a pessoas-chave.",
      mediumDescription: "O ZapFlow conecta inteligência, operação e execução para a empresa funcionar de forma mais organizada, previsível e menos dependente do proprietário — observando o que acontece, organizando o que precisa ser feito e acionando a execução.",
      longDescription: null,
      functionalMessages: [
        "O ZapFlow identifica oportunidades que pararam e ajuda sua equipe a agir.",
        "Cobranças, retornos e follow-ups deixam de depender de alguém lembrar.",
        "Você enxerga o que está acontecendo na operação sem precisar perguntar.",
      ],
      emotionalMessages: [
        "Menos sensação de apagar incêndios.",
        "Confiança para delegar e se afastar sem a empresa parar.",
      ],
      objectionResponses: [
        { objection: "É só mais um CRM/chatbot?", response: "Não. O ZapFlow não só responde — transforma contexto em ação dentro da operação." },
        { objection: "Vai substituir meus funcionários?", response: "Não substitui pessoas; reduz a dependência de que tudo passe por elas ou pela memória delas." },
      ],
      vocabulary: ["dependência operacional", "execução", "acompanhamento", "previsibilidade", "organização"],
      discouragedTerms: ["apenas um chatbot", "robô que faz tudo sozinho", "substitui a equipe"],
      toneOfVoice: "Conselheiro de confiança: direto, honesto, sem jargão. Clareza operacional antes de personalidade.",
    },
  };
}

/** Normaliza um patch parcial em cima de um snapshot base — só campos conhecidos, shapes seguros. */
function mergeSnapshot(base: BrandCoreSnapshot, patch: any): BrandCoreSnapshot {
  const p = patch || {};
  return {
    essence: "essence" in p ? str(p.essence) : base.essence,
    purpose: "purpose" in p ? str(p.purpose) : base.purpose,
    category: "category" in p ? str(p.category) : base.category,
    positioning: "positioning" in p ? str(p.positioning) : base.positioning,
    promise: "promise" in p ? str(p.promise) : base.promise,
    coreProblem: "coreProblem" in p ? str(p.coreProblem) : base.coreProblem,
    coreProblemManifestations: "coreProblemManifestations" in p ? strArr(p.coreProblemManifestations) : base.coreProblemManifestations,
    enemy: "enemy" in p ? str(p.enemy) : base.enemy,
    targetAudience: "targetAudience" in p ? { primary: strArr(p.targetAudience?.primary) } : base.targetAudience,
    transformation: "transformation" in p ? { before: strArr(p.transformation?.before), after: strArr(p.transformation?.after) } : base.transformation,
    mechanism: "mechanism" in p ? { steps: arr(p.mechanism?.steps).map((s: any, i: number) => ({ key: String(s?.key || `step_${i + 1}`), label: String(s?.label || ""), order: Number(s?.order) || i + 1 })) } : base.mechanism,
    brandAttributes: "brandAttributes" in p ? strArr(p.brandAttributes) : base.brandAttributes,
    functionalBenefits: "functionalBenefits" in p ? strArr(p.functionalBenefits) : base.functionalBenefits,
    emotionalBenefits: "emotionalBenefits" in p ? strArr(p.emotionalBenefits) : base.emotionalBenefits,
    differentiators: "differentiators" in p ? arr(p.differentiators).map((d: any) => ({ title: String(d?.title || ""), description: String(d?.description || "") })).filter((d) => d.title || d.description) : base.differentiators,
    proofPoints: "proofPoints" in p ? arr(p.proofPoints) : base.proofPoints,
    approvedClaims: "approvedClaims" in p ? strArr(p.approvedClaims) : base.approvedClaims,
    restrictedClaims: "restrictedClaims" in p ? strArr(p.restrictedClaims) : base.restrictedClaims,
    messaging: "messaging" in p ? mergeMessaging(base.messaging || emptyMessaging(), p.messaging) : (base.messaging || emptyMessaging()),
  };
}

// Merge parcial da message house (PRD 02) sobre a base, com shapes seguros.
function mergeMessaging(base: BrandMessaging, patch: any): BrandMessaging {
  const p = patch || {};
  return {
    masterMessage: "masterMessage" in p ? str(p.masterMessage) : base.masterMessage,
    tagline: "tagline" in p ? str(p.tagline) : base.tagline,
    elevatorPitch: "elevatorPitch" in p ? str(p.elevatorPitch) : base.elevatorPitch,
    shortDescription: "shortDescription" in p ? str(p.shortDescription) : base.shortDescription,
    mediumDescription: "mediumDescription" in p ? str(p.mediumDescription) : base.mediumDescription,
    longDescription: "longDescription" in p ? str(p.longDescription) : base.longDescription,
    functionalMessages: "functionalMessages" in p ? strArr(p.functionalMessages) : base.functionalMessages,
    emotionalMessages: "emotionalMessages" in p ? strArr(p.emotionalMessages) : base.emotionalMessages,
    objectionResponses: "objectionResponses" in p
      ? arr(p.objectionResponses).map((o: any) => ({ objection: String(o?.objection || "").trim(), response: String(o?.response || "").trim() })).filter((o) => o.objection || o.response)
      : base.objectionResponses,
    vocabulary: "vocabulary" in p ? strArr(p.vocabulary) : base.vocabulary,
    discouragedTerms: "discouragedTerms" in p ? strArr(p.discouragedTerms) : base.discouragedTerms,
    toneOfVoice: "toneOfVoice" in p ? str(p.toneOfVoice) : base.toneOfVoice,
  };
}

export class BrandCoreService {
  private static parse(row: any): any {
    if (!row) return null;
    let snapshot: BrandCoreSnapshot;
    try { snapshot = JSON.parse(row.snapshot_json); } catch { snapshot = brandCoreDefaults(); }
    if (snapshot && !snapshot.messaging) snapshot.messaging = emptyMessaging(); // versão pré-PRD 02
    return {
      version: row.version, status: row.status as BrandCoreStatus, revision: row.revision,
      sourceVersion: row.source_version ?? null,
      createdBy: row.created_by ?? null, createdAt: row.created_at ?? null,
      updatedBy: row.updated_by ?? null, updatedAt: row.updated_at ?? null,
      publishedBy: row.published_by ?? null, publishedAt: row.published_at ?? null,
      snapshot,
    };
  }

  private static maxVersion(): number {
    const r = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM brand_core_versions").get() as any;
    return Number(r?.v) || 0;
  }

  private static rowByStatus(status: BrandCoreStatus): any {
    return db.prepare("SELECT * FROM brand_core_versions WHERE status = ? ORDER BY version DESC LIMIT 1").get(status);
  }

  /** Versão publicada ativa (snapshot puro) ou {status:'not_configured'} — fallback §44 (nunca derruba, nunca inventa). */
  static getPublished(): { status: "not_configured" } | ({ status: "published"; version: number } & BrandCoreSnapshot) {
    const row = this.rowByStatus("published");
    if (!row) return { status: "not_configured" };
    const parsed = this.parse(row);
    return { status: "published", version: parsed.version, ...parsed.snapshot };
  }

  /**
   * Resolver estável de leitura (§30) para consumidores futuros (Estúdio, Fala Tu, Diretor
   * IA, etc.). Neste PRD ninguém é migrado — o resolver só precisa existir. Consumidores
   * NUNCA leem a tabela direto (§31): usam este método.
   */
  static getBrandCoreContext(): { configured: boolean; version: number | null; brand: BrandCoreSnapshot | null } {
    const row = this.rowByStatus("published");
    if (!row) return { configured: false, version: null, brand: null };
    const parsed = this.parse(row);
    return { configured: true, version: parsed.version, brand: parsed.snapshot };
  }

  /**
   * Resolver da MESSAGE HOUSE (PRD 02) — `getBrandMessaging()`. Consumidores de conteúdo
   * (site, Estúdio, propostas…) pedem isto em vez de hardcodar posicionamento. Expõe os
   * claims PROIBIDOS reusando `restrictedClaims` do Brand Core (não duplica). Sem versão
   * publicada → not_configured (nunca inventa). Nenhum consumidor migrado neste PRD (§ só
   * disponibiliza o resolver).
   */
  static getBrandMessaging(): { configured: boolean; version: number | null; messaging: (BrandMessaging & { prohibitedClaims: string[] }) | null } {
    const row = this.rowByStatus("published");
    if (!row) return { configured: false, version: null, messaging: null };
    const parsed = this.parse(row);
    const m: BrandMessaging = parsed.snapshot.messaging || emptyMessaging();
    return { configured: true, version: parsed.version, messaging: { ...m, prohibitedClaims: parsed.snapshot.restrictedClaims || [] } };
  }

  /** Draft corrente (único) ou null. */
  static getDraft(): any { return this.parse(this.rowByStatus("draft")); }

  /** Uma versão específica (metadados + snapshot). */
  static getVersion(version: number): any {
    return this.parse(db.prepare("SELECT * FROM brand_core_versions WHERE version = ?").get(version));
  }

  /** Histórico (metadados, sem snapshot pesado), mais novo primeiro. */
  static listVersions(): any[] {
    const rows = db.prepare("SELECT version, status, revision, source_version, created_by, created_at, published_by, published_at FROM brand_core_versions ORDER BY version DESC").all() as any[];
    return rows.map((r) => ({
      version: r.version, status: r.status, revision: r.revision, sourceVersion: r.source_version ?? null,
      createdBy: r.created_by ?? null, createdAt: r.created_at ?? null, publishedBy: r.published_by ?? null, publishedAt: r.published_at ?? null,
    }));
  }

  /** Estado para a Admin UI: publicada + draft + histórico. */
  static getState(): { published: any; draft: any; versions: any[] } {
    const pub = this.rowByStatus("published");
    return { published: pub ? this.parse(pub) : null, draft: this.getDraft(), versions: this.listVersions() };
  }

  /**
   * Cria um DRAFT. Se já houver draft, devolve o existente (single-draft, sem duplicar).
   * Base = versão publicada (clone) ou, sem publicada, o draft estratégico inicial (§43).
   */
  static createDraft(actor?: string): any {
    const existing = this.getDraft();
    if (existing) return existing;
    const pub = this.rowByStatus("published");
    const base: BrandCoreSnapshot = pub ? this.parse(pub).snapshot : brandCoreDefaults();
    const sourceVersion = pub ? this.parse(pub).version : null;
    const version = this.maxVersion() + 1;
    const id = randomUUID();
    db.prepare(`INSERT INTO brand_core_versions (id, version, status, snapshot_json, revision, source_version, created_by, updated_by)
      VALUES (?, ?, 'draft', ?, 1, ?, ?, ?)`).run(id, version, JSON.stringify(base), sourceVersion, actor || null, actor || null);
    try { logAuthEvent(PLATFORM, actor, null, "brand_core.draft_created", { version, sourceVersion }); } catch { /* best-effort */ }
    return this.getDraft();
  }

  /**
   * Atualiza o draft (merge parcial). `expectedRevision` faz o controle otimista: se o draft
   * mudou desde que o editor carregou, LANÇA 'conflict' — nunca sobrescreve silenciosamente (§28).
   */
  static updateDraft(patch: any, expectedRevision: number, actor?: string): any {
    const draft = this.getDraft();
    if (!draft) throw new Error("Nenhum draft aberto. Crie um draft primeiro.");
    const merged = mergeSnapshot(draft.snapshot, patch);
    const upd = db.prepare(`UPDATE brand_core_versions SET snapshot_json = ?, revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'draft' AND version = ? AND revision = ?`).run(JSON.stringify(merged), actor || null, draft.version, Number(expectedRevision));
    if (upd.changes === 0) {
      const cur = this.getDraft();
      const err: any = new Error("conflict"); err.code = "CONFLICT"; err.currentRevision = cur?.revision ?? null;
      throw err;
    }
    try { logAuthEvent(PLATFORM, actor, null, "brand_core.draft_updated", { version: draft.version }); } catch { /* best-effort */ }
    return this.getDraft();
  }

  /** Valida se um snapshot pode ser publicado (§36). Retorna {ok, missing[]}. */
  static validate(snapshot: BrandCoreSnapshot): { ok: boolean; missing: string[] } {
    const missing: string[] = [];
    for (const k of REQUIRED_TEXT) if (!str((snapshot as any)[k])) missing.push(k);
    if (!snapshot.transformation || !strArr(snapshot.transformation.before).length || !strArr(snapshot.transformation.after).length) missing.push("transformation");
    if (!snapshot.mechanism || !arr(snapshot.mechanism.steps).length) missing.push("mechanism");
    return { ok: missing.length === 0, missing };
  }

  /**
   * Publica o draft: valida obrigatórios, ARQUIVA a publicada anterior (nunca apaga) e promove
   * o draft a published. Atômico. `expectedRevision` protege contra publicar um draft alterado
   * por outro admin no meio do caminho.
   */
  static publish(actor: string | undefined, expectedRevision: number): any {
    const draft = this.getDraft();
    if (!draft) throw new Error("Nenhum draft para publicar.");
    if (Number(expectedRevision) !== draft.revision) {
      const err: any = new Error("conflict"); err.code = "CONFLICT"; err.currentRevision = draft.revision; throw err;
    }
    const v = this.validate(draft.snapshot);
    if (!v.ok) { const err: any = new Error("incomplete"); err.code = "INCOMPLETE"; err.missing = v.missing; throw err; }
    const prevPub = this.rowByStatus("published");
    const tx = db.transaction(() => {
      if (prevPub) db.prepare("UPDATE brand_core_versions SET status = 'archived' WHERE version = ?").run(prevPub.version);
      db.prepare(`UPDATE brand_core_versions SET status = 'published', published_by = ?, published_at = CURRENT_TIMESTAMP
        WHERE status = 'draft' AND version = ? AND revision = ?`).run(actor || null, draft.version, Number(expectedRevision));
    });
    tx();
    try { logAuthEvent(PLATFORM, actor, null, "brand_core.version_published", { version: draft.version, previousVersion: prevPub?.version ?? null }); } catch { /* best-effort */ }
    return this.getVersion(draft.version);
  }

  /**
   * Restore = cria um NOVO draft a partir de uma versão antiga (nunca sobrescreve histórico,
   * §27). Exige que NÃO haja draft aberto (single-draft) — descarte o atual primeiro.
   */
  static restoreToDraft(fromVersion: number, actor?: string): any {
    if (this.getDraft()) throw new Error("Já existe um draft aberto. Descarte-o antes de restaurar outra versão.");
    const src = this.getVersion(fromVersion);
    if (!src) throw new Error("Versão de origem não encontrada.");
    const version = this.maxVersion() + 1;
    const id = randomUUID();
    db.prepare(`INSERT INTO brand_core_versions (id, version, status, snapshot_json, revision, source_version, created_by, updated_by)
      VALUES (?, ?, 'draft', ?, 1, ?, ?, ?)`).run(id, version, JSON.stringify(src.snapshot), fromVersion, actor || null, actor || null);
    try { logAuthEvent(PLATFORM, actor, null, "brand_core.version_restored_to_draft", { version, sourceVersion: fromVersion }); } catch { /* best-effort */ }
    return this.getDraft();
  }

  /** Descarta o draft aberto (não afeta publicada nem histórico). */
  static discardDraft(actor?: string): { discarded: boolean } {
    const draft = this.getDraft();
    if (!draft) return { discarded: false };
    db.prepare("DELETE FROM brand_core_versions WHERE status = 'draft' AND version = ?").run(draft.version);
    try { logAuthEvent(PLATFORM, actor, null, "brand_core.draft_deleted", { version: draft.version }); } catch { /* best-effort */ }
    return { discarded: true };
  }
}

export default BrandCoreService;
