import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

/**
 * RBAC granular (ADR-095) — resolve o NÍVEL de acesso de um usuário a um módulo.
 *
 * Modelo: cada organização tem `role_profiles` (perfis), e cada perfil tem um
 * mapa `módulo → nível` em `role_permissions`. O usuário aponta para um perfil
 * via `users.role_profile_id`.
 *
 * NÃO-QUEBRA: enquanto o usuário não tiver um perfil atribuído (role_profile_id
 * nulo — todo o parque hoje), cai no FALLBACK dos papéis legados
 * (owner/admin/agent, coluna users.role / claim do JWT). Assim a introdução do
 * RBAC não muda o comportamento de ninguém até o dono atribuir perfis.
 *
 * Níveis (ordenados): none < read < write < full.
 *  - read  → GET (somente leitura)
 *  - write → GET/POST/PUT/PATCH (cria e edita, MAS não exclui)
 *  - full  → tudo, incluindo DELETE
 */
export type Level = "none" | "read" | "write" | "full";
export type Action = "read" | "write" | "delete";

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2, full: 3 };
const ACTION_MIN: Record<Action, Level> = { read: "read", write: "write", delete: "full" };

// Módulos de negócio para os quais o acesso é controlável por perfil. Alinhado
// aos módulos do produto (ModuleService), mais os administrativos sensíveis
// (cobrança, usuários/permissões, configurações).
export const RBAC_MODULES = [
  "atendimento", "contatos", "vendas", "catalogo", "loja", "pagamentos",
  "compras", "orcamentos", "agenda", "reservas", "assinaturas", "campanhas",
  "cadencias", "areas", "integracoes", "eventos", "diretor", "estudio",
  "rie", "execucao", "relatorios", "cobranca", "usuarios", "configuracoes",
] as const;
export type RbacModule = (typeof RBAC_MODULES)[number];

// 1º segmento da rota (/api/<seg>/...) → módulo RBAC. Espelha o
// ModuleService.MODULE_BY_ROUTE, mas SÓ os segmentos cujo módulo é governado
// pelo RBAC granular. Add-ons com gating próprio por papel (prospect/clinic/
// vision/radar/retailops) e rotas administrativas auto-gated (users/permissions)
// ficam de fora — o enforcement global nunca as bloqueia. Segmentos ausentes
// deste mapa são tratados como core/infra e passam sem checagem.
export const ROUTE_MODULE: Record<string, string> = {
  products: "catalogo",
  orders: "vendas",
  storefront: "loja",
  payments: "pagamentos",
  appointments: "agenda",
  campaigns: "campanhas",
  cadences: "cadencias",
  areas: "areas",
  integrations: "integracoes",
  reservations: "reservas",
  subscriptions: "assinaturas",
  procurement: "compras",
  quotes: "orcamentos",
  events: "eventos",
  executive: "diretor",
  studio: "estudio",
  tasks: "execucao",
};

// Rótulos amigáveis para a tela de editor de perfis (Bloco 3).
export const RBAC_MODULE_LABELS: Record<string, string> = {
  atendimento: "Atendimento", contatos: "Contatos", vendas: "Vendas",
  catalogo: "Catálogo", loja: "Loja Virtual", pagamentos: "Pagamentos",
  compras: "Compras", orcamentos: "Orçamentos", agenda: "Agenda",
  reservas: "Reservas", assinaturas: "Assinaturas", campanhas: "Campanhas",
  cadencias: "Cadências", areas: "Áreas", integracoes: "Integrações",
  eventos: "Eventos", diretor: "Diretor Executivo IA", estudio: "Estúdio",
  rie: "Revenue Intelligence", execucao: "Execução / Tarefas",
  relatorios: "Relatórios", cobranca: "Cobrança / Assinatura",
  usuarios: "Usuários e Permissões", configuracoes: "Configurações",
};

type ProfileSpec = { key: string; name: string; default: Level; overrides: Partial<Record<string, Level>> };

// Os 6 templates semeados (ADR-095 §2). `default` é o nível dos módulos não
// citados em `overrides`. "Dono" é sempre full e imutável.
export const SYSTEM_PROFILES: ProfileSpec[] = [
  { key: "owner", name: "Dono", default: "full", overrides: {} },
  {
    key: "gerente", name: "Gerente", default: "full",
    overrides: { cobranca: "read", configuracoes: "read" },
  },
  {
    key: "vendedor", name: "Vendedor", default: "none",
    overrides: { vendas: "write", catalogo: "read", atendimento: "write", contatos: "write" },
  },
  {
    key: "estoquista", name: "Estoquista", default: "none",
    overrides: { catalogo: "write", compras: "write" },
  },
  {
    key: "financeiro", name: "Financeiro", default: "none",
    overrides: { vendas: "read", pagamentos: "full", relatorios: "read", cobranca: "full" },
  },
  {
    key: "atendente", name: "Atendente", default: "none",
    overrides: { atendimento: "write", contatos: "write" },
  },
];

// Papel legado (users.role) → chave do template equivalente (fallback).
const LEGACY_TO_SYSTEM: Record<string, string> = {
  owner: "owner",
  admin: "gerente",
  agent: "atendente",
};

export class PermissionService {
  static LEVELS: Level[] = ["none", "read", "write", "full"];

  /** Nível de um ProfileSpec para um módulo (default + override). */
  private static specLevel(spec: ProfileSpec, module: string): Level {
    return (spec.overrides[module] as Level) || spec.default;
  }

  /**
   * Semeia os 6 templates para uma organização (idempotente). Cria o perfil e
   * suas permissões por módulo só se ainda não existir (por system_key). Retorna
   * quantos perfis foram criados nesta chamada.
   */
  static seedSystemProfiles(orgId: string): number {
    let created = 0;
    const insProfile = db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, ?, ?, 1)`);
    const insPerm = db.prepare(`INSERT OR REPLACE INTO role_permissions (role_profile_id, module, level) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const spec of SYSTEM_PROFILES) {
        const existing = db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(orgId, spec.key) as any;
        if (existing) continue;
        const id = uuidv4();
        insProfile.run(id, orgId, spec.name, spec.key);
        for (const module of RBAC_MODULES) insPerm.run(id, module, this.specLevel(spec, module));
        created++;
      }
    });
    tx();
    if (created) console.log(`[RBAC] Semeados ${created} perfil(is) de sistema p/ org ${orgId}.`);
    return created;
  }

  /** Resolve o role_profile_id efetivo do usuário (do objeto do JWT ou do banco). */
  private static resolveProfileId(orgId: string, user: any): string | null {
    if (!user) return null;
    if (user.role_profile_id) return user.role_profile_id;
    const uid = user.userId || user.id;
    if (!uid) return null;
    try {
      const row = db.prepare(`SELECT role_profile_id FROM users WHERE id = ? AND organization_id = ?`).get(uid, orgId) as any;
      return row?.role_profile_id || null;
    } catch { return null; }
  }

  /** Nível de acesso do usuário a um módulo (via perfil, ou fallback legado). */
  static levelFor(orgId: string, user: any, module: string): Level {
    const profileId = this.resolveProfileId(orgId, user);
    if (profileId) {
      const prof = db.prepare(`SELECT system_key FROM role_profiles WHERE id = ? AND organization_id = ?`).get(profileId, orgId) as any;
      // O Dono é sempre full, inclusive em módulos criados depois do seed.
      if (prof?.system_key === "owner") return "full";
      const row = db.prepare(`SELECT level FROM role_permissions WHERE role_profile_id = ? AND module = ?`).get(profileId, module) as any;
      return (row?.level as Level) || "none";
    }
    // Fallback legado: mapeia users.role para o template equivalente.
    const legacy = String(user?.role || "agent");
    const spec = SYSTEM_PROFILES.find((s) => s.key === LEGACY_TO_SYSTEM[legacy]) || SYSTEM_PROFILES.find((s) => s.key === "atendente")!;
    return this.specLevel(spec, module);
  }

  /** O usuário pode executar `action` no `module`? */
  static can(orgId: string, user: any, module: string, action: Action): boolean {
    const level = this.levelFor(orgId, user, module);
    return RANK[level] >= RANK[ACTION_MIN[action]];
  }

  /** O usuário tem um perfil RBAC explicitamente atribuído? (opt-in do gating). */
  static hasProfile(orgId: string, user: any): boolean {
    return this.resolveProfileId(orgId, user) != null;
  }

  /** Módulo RBAC de um 1º segmento de rota, ou null (segmento não gateado). */
  static moduleForSegment(segment?: string | null): string | null {
    if (!segment) return null;
    return ROUTE_MODULE[segment] || null;
  }

  /** Mapa módulo → nível para o usuário (consumido por GET /api/permissions/me). */
  static permissionMap(orgId: string, user: any): Record<string, Level> {
    const out: Record<string, Level> = {};
    for (const m of RBAC_MODULES) out[m] = this.levelFor(orgId, user, m);
    return out;
  }

  // ---- Gestão de perfis (ADR-095 Bloco 2) ----

  /** Um nível válido? */
  private static isLevel(v: any): v is Level {
    return v === "none" || v === "read" || v === "write" || v === "full";
  }

  /** Lê o mapa módulo→nível de um perfil (preenche os ausentes com 'none'). */
  private static permsOf(profileId: string): Record<string, Level> {
    const rows = db.prepare(`SELECT module, level FROM role_permissions WHERE role_profile_id = ?`).all(profileId) as any[];
    const map: Record<string, Level> = {};
    for (const m of RBAC_MODULES) map[m] = "none";
    for (const r of rows) if (RBAC_MODULES.includes(r.module)) map[r.module] = r.level;
    return map;
  }

  /** Um perfil com seu mapa de permissões, ou null. */
  static getProfile(orgId: string, id: string): any | null {
    const p = db.prepare(`SELECT id, name, system_key, is_system FROM role_profiles WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!p) return null;
    return { id: p.id, name: p.name, systemKey: p.system_key || null, isSystem: !!p.is_system, permissions: this.permsOf(p.id) };
  }

  /** Todos os perfis da org (semeia os templates se ainda não houver nenhum). */
  static listProfiles(orgId: string): any[] {
    const count = (db.prepare(`SELECT COUNT(*) c FROM role_profiles WHERE organization_id = ?`).get(orgId) as any).c;
    if (!count) this.seedSystemProfiles(orgId);
    const rows = db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? ORDER BY is_system DESC, name ASC`).all(orgId) as any[];
    return rows.map((r) => {
      const prof = this.getProfile(orgId, r.id);
      const usersCount = (db.prepare(`SELECT COUNT(*) c FROM users WHERE organization_id = ? AND role_profile_id = ?`).get(orgId, r.id) as any).c;
      return { ...prof, usersCount };
    });
  }

  /** Normaliza um mapa de permissões vindo da API (só módulos e níveis válidos). */
  private static sanitizePerms(perms: any): Record<string, Level> {
    const out: Record<string, Level> = {};
    for (const m of RBAC_MODULES) out[m] = "none";
    if (perms && typeof perms === "object") {
      for (const [k, v] of Object.entries(perms)) {
        if (RBAC_MODULES.includes(k as any) && this.isLevel(v)) out[k] = v;
      }
    }
    return out;
  }

  /** Cria um perfil customizado (is_system=0). Retorna o id. */
  static createProfile(orgId: string, name: string, perms: any): string {
    const clean = this.sanitizePerms(perms);
    const id = uuidv4();
    const insPerm = db.prepare(`INSERT OR REPLACE INTO role_permissions (role_profile_id, module, level) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, ?, NULL, 0)`)
        .run(id, orgId, String(name || "Novo perfil").slice(0, 80));
      for (const m of RBAC_MODULES) insPerm.run(id, m, clean[m]);
    });
    tx();
    return id;
  }

  /** Atualiza nome e/ou permissões. O Dono (system_key='owner') é imutável. */
  static updateProfile(orgId: string, id: string, patch: { name?: string; permissions?: any }): { ok: boolean; error?: string } {
    const p = db.prepare(`SELECT system_key FROM role_profiles WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!p) return { ok: false, error: "not_found" };
    if (p.system_key === "owner") return { ok: false, error: "owner_immutable" };
    const tx = db.transaction(() => {
      if (patch.name !== undefined)
        db.prepare(`UPDATE role_profiles SET name = ? WHERE id = ? AND organization_id = ?`).run(String(patch.name).slice(0, 80), id, orgId);
      if (patch.permissions !== undefined) {
        const clean = this.sanitizePerms(patch.permissions);
        const insPerm = db.prepare(`INSERT OR REPLACE INTO role_permissions (role_profile_id, module, level) VALUES (?, ?, ?)`);
        for (const m of RBAC_MODULES) insPerm.run(id, m, clean[m]);
      }
    });
    tx();
    return { ok: true };
  }

  /** Duplica um perfil (novo perfil custom com as mesmas permissões). Retorna o id. */
  static duplicateProfile(orgId: string, id: string, newName?: string): string | null {
    const src = this.getProfile(orgId, id);
    if (!src) return null;
    return this.createProfile(orgId, newName || `${src.name} (cópia)`, src.permissions);
  }

  /** Exclui um perfil. Bloqueia o Dono e qualquer perfil com usuários atribuídos. */
  static deleteProfile(orgId: string, id: string): { ok: boolean; error?: string } {
    const p = db.prepare(`SELECT system_key FROM role_profiles WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!p) return { ok: false, error: "not_found" };
    if (p.system_key === "owner") return { ok: false, error: "owner_immutable" };
    const assigned = (db.prepare(`SELECT COUNT(*) c FROM users WHERE organization_id = ? AND role_profile_id = ?`).get(orgId, id) as any).c;
    if (assigned > 0) return { ok: false, error: "has_users" };
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM role_permissions WHERE role_profile_id = ?`).run(id);
      db.prepare(`DELETE FROM role_profiles WHERE id = ? AND organization_id = ?`).run(id, orgId);
    });
    tx();
    return { ok: true };
  }

  /** Atribui um perfil a um usuário (valida que o perfil é da mesma org). */
  static assignToUser(orgId: string, userId: string, profileId: string): { ok: boolean; error?: string } {
    const prof = db.prepare(`SELECT id FROM role_profiles WHERE id = ? AND organization_id = ?`).get(profileId, orgId) as any;
    if (!prof) return { ok: false, error: "profile_not_found" };
    const u = db.prepare(`SELECT id FROM users WHERE id = ? AND organization_id = ?`).get(userId, orgId) as any;
    if (!u) return { ok: false, error: "user_not_found" };
    db.prepare(`UPDATE users SET role_profile_id = ? WHERE id = ? AND organization_id = ?`).run(profileId, userId, orgId);
    return { ok: true };
  }

  /** Semeia os templates para TODAS as orgs (backfill idempotente no boot). */
  static backfillSystemProfiles(): { orgs: number } {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings`).all() as any[]; }
    catch { return { orgs: 0 }; }
    let seeded = 0;
    for (const o of orgs) { try { if (this.seedSystemProfiles(o.organization_id) > 0) seeded++; } catch { /* noop */ } }
    if (seeded) console.log(`[RBAC] Backfill: templates semeados em ${seeded} organização(ões).`);
    return { orgs: orgs.length };
  }
}
