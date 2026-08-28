/**
 * CompetitorIntelligenceService — Closure Track B do PRD-PEL-01, fatia F1.
 *
 * Ledger per-org de contas de concorrentes que a organização quer monitorar.
 * Esta fatia é somente cadastro (CRUD); fatias posteriores farão ingestão de
 * posts (F2), classificação por recipe do VRE (F3) e insights (F4).
 *
 * Regras (RN-CI-01..05):
 *   1. handle regex: 1-32 chars, [A-Za-z0-9_.] (padrão comum de handles de rede)
 *   2. platform ∈ SUPPORTED_PLATFORMS (validado no create/update)
 *   3. UNIQUE (organization_id, platform, LOWER(handle)) — mesma org não pode
 *      ter duplicata; case-insensitive.
 *   4. Multi-tenant strict: toda query filtra por organization_id.
 *   5. Delete = soft delete (active=0). hardDelete disponível pra teardown.
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";

export const HANDLE_REGEX = /^[A-Za-z0-9_.]{1,32}$/;

export const SUPPORTED_PLATFORMS = [
  "instagram", "tiktok", "youtube", "linkedin", "x", "facebook",
] as const;
export type Platform = typeof SUPPORTED_PLATFORMS[number];

export interface CompetitorRow {
  id: string;
  organization_id: string;
  platform: string;
  handle: string;
  display_name: string | null;
  notes: string | null;
  tags_json: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface Competitor {
  id: string;
  organization_id: string;
  platform: Platform;
  handle: string;
  display_name: string | null;
  notes: string | null;
  tags: string[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

export class CompetitorError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg); this.code = code; this.name = "CompetitorError";
  }
}

function rowToCompetitor(r: CompetitorRow): Competitor {
  let tags: string[] = [];
  if (r.tags_json) {
    try { tags = JSON.parse(r.tags_json); if (!Array.isArray(tags)) tags = []; }
    catch { tags = []; }
  }
  return {
    id: r.id,
    organization_id: r.organization_id,
    platform: r.platform as Platform,
    handle: r.handle,
    display_name: r.display_name,
    notes: r.notes,
    tags,
    active: r.active === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeHandle(input: string): string {
  return input.trim().replace(/^@/, "");
}

export class CompetitorIntelligenceService {

  /** Cria um novo cadastro de concorrente per-org. */
  static addCompetitor(input: {
    orgId: string;
    platform: string;
    handle: string;
    display_name?: string | null;
    notes?: string | null;
    tags?: string[];
  }): Competitor {
    if (!input.orgId) throw new CompetitorError("missing_org", "orgId é obrigatório");
    if (!input.platform) throw new CompetitorError("missing_platform", "platform é obrigatório");
    if (!SUPPORTED_PLATFORMS.includes(input.platform as Platform)) {
      throw new CompetitorError("invalid_platform",
        `platform inválido: ${input.platform}. Aceitos: ${SUPPORTED_PLATFORMS.join(", ")}`);
    }
    const handle = normalizeHandle(input.handle || "");
    if (!handle) throw new CompetitorError("missing_handle", "handle é obrigatório");
    if (!HANDLE_REGEX.test(handle)) {
      throw new CompetitorError("invalid_handle",
        `handle inválido: ${handle}. Formato: ${HANDLE_REGEX.source}`);
    }

    // Duplicata case-insensitive dentro da mesma org+platform
    const dup = db.prepare(
      "SELECT id FROM competitor_accounts WHERE organization_id = ? AND platform = ? AND LOWER(handle) = LOWER(?)"
    ).get(input.orgId, input.platform, handle);
    if (dup) {
      throw new CompetitorError("duplicate_competitor",
        `concorrente já existe: ${input.platform}/@${handle}`);
    }

    const tags = Array.isArray(input.tags) ? input.tags.filter(t => typeof t === "string" && t.trim()).slice(0, 20) : [];
    const id = uuidv4();
    db.prepare(
      `INSERT INTO competitor_accounts
       (id, organization_id, platform, handle, display_name, notes, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, input.orgId, input.platform, handle,
      input.display_name?.trim() || null,
      input.notes?.trim() || null,
      tags.length > 0 ? JSON.stringify(tags) : null,
    );

    return this.getCompetitor(input.orgId, id)!;
  }

  /** Retorna 1 concorrente por id (dentro da org). Null se não achou. */
  static getCompetitor(orgId: string, id: string): Competitor | null {
    if (!orgId || !id) return null;
    const row = db.prepare(
      "SELECT * FROM competitor_accounts WHERE id = ? AND organization_id = ?"
    ).get(id, orgId) as CompetitorRow | undefined;
    return row ? rowToCompetitor(row) : null;
  }

  /**
   * Lista concorrentes da org. Filtros opcionais:
   *  - `includeInactive` (default false): traz também soft-deleted
   *  - `platform`: filtra por plataforma
   */
  static listCompetitors(orgId: string, opts: {
    includeInactive?: boolean;
    platform?: string;
  } = {}): Competitor[] {
    if (!orgId) return [];
    const wheres: string[] = ["organization_id = ?"];
    const params: any[] = [orgId];
    if (!opts.includeInactive) wheres.push("active = 1");
    if (opts.platform) { wheres.push("platform = ?"); params.push(opts.platform); }
    const rows = db.prepare(
      `SELECT * FROM competitor_accounts
        WHERE ${wheres.join(" AND ")}
        ORDER BY platform, LOWER(handle)`
    ).all(...params) as CompetitorRow[];
    return rows.map(rowToCompetitor);
  }

  /**
   * Update parcial. `handle` e `platform` são imutáveis por design — mudança
   * exige delete + create pra manter histórico limpo. Retorna null se não
   * achou.
   */
  static updateCompetitor(orgId: string, id: string, patch: {
    display_name?: string | null;
    notes?: string | null;
    tags?: string[];
    active?: boolean;
  }): Competitor | null {
    const current = this.getCompetitor(orgId, id);
    if (!current) return null;

    const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
    const params: any[] = [];
    if (Object.prototype.hasOwnProperty.call(patch, "display_name")) {
      sets.push("display_name = ?");
      params.push(patch.display_name?.trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "notes")) {
      sets.push("notes = ?");
      params.push(patch.notes?.trim() || null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "tags")) {
      const tags = Array.isArray(patch.tags) ? patch.tags.filter(t => typeof t === "string" && t.trim()).slice(0, 20) : [];
      sets.push("tags_json = ?");
      params.push(tags.length > 0 ? JSON.stringify(tags) : null);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "active")) {
      sets.push("active = ?");
      params.push(patch.active ? 1 : 0);
    }

    if (sets.length === 1) return current; // nada além de updated_at → no-op efetivo

    params.push(id, orgId);
    db.prepare(
      `UPDATE competitor_accounts SET ${sets.join(", ")}
        WHERE id = ? AND organization_id = ?`
    ).run(...params);
    return this.getCompetitor(orgId, id);
  }

  /** Soft delete: marca active=0. Retorna true se algo mudou. */
  static deactivate(orgId: string, id: string): boolean {
    const info = db.prepare(
      "UPDATE competitor_accounts SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND active = 1"
    ).run(id, orgId);
    return info.changes > 0;
  }

  /** Reativa um soft-deleted. Retorna true se algo mudou. */
  static reactivate(orgId: string, id: string): boolean {
    const info = db.prepare(
      "UPDATE competitor_accounts SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND active = 0"
    ).run(id, orgId);
    return info.changes > 0;
  }

  /**
   * Hard delete — usado por teardown/testes ou pelo próprio dono via UI
   * confirmatória. Só remove se a org for dona. Retorna true se removeu.
   * A partir do F2 (Track B), cascata manual apaga posts do competitor
   * — SQLite não força FK sem PRAGMA foreign_keys=ON globalmente.
   */
  static hardDelete(orgId: string, id: string): boolean {
    // Verifica ownership primeiro pra não gastar cascade em ninguém.
    const owned = db.prepare(
      "SELECT 1 FROM competitor_accounts WHERE id = ? AND organization_id = ?"
    ).get(id, orgId);
    if (!owned) return false;
    // Import dinâmico pra evitar ciclo (CompetitorPostsService é opcional).
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { CompetitorPostsService } = require("./CompetitorPostsService.js");
      CompetitorPostsService.deleteAllForCompetitor(id);
    } catch { /* posts service não presente — F1 puro */ }
    const info = db.prepare(
      "DELETE FROM competitor_accounts WHERE id = ? AND organization_id = ?"
    ).run(id, orgId);
    return info.changes > 0;
  }
}
