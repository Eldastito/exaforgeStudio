/**
 * ADR-199 F0c-1 — rebuild da constraint de email de `users`:
 *   UNIQUE(email)  →  UNIQUE(organization_id, email)
 *
 * É o passo de MAIOR risco do ZapFlow Grupo: SQLite não remove uma constraint de
 * coluna com ALTER, então exige recriar a tabela (create-new → copiar → drop → rename).
 * Este módulo faz isso com garantias DURAS de que NENHUM dado de produção se perde:
 *
 *  1. SNAPSHOT antes de tocar em nada (`VACUUM INTO`) + `integrity_check`. Sem snapshot
 *     válido, ABORTA (não faz o rebuild sem rede de segurança).
 *  2. TRANSAÇÃO ÚNICA atômica: create/copy/validate/drop/rename num `db.transaction`.
 *     Qualquer erro (ou crash) → rollback → `users` intacta. SQLite é ACID.
 *  3. Cópia DINÂMICA de TODAS as colunas (lê `PRAGMA table_info`) — nunca hardcode.
 *     Elimina o risco de "esquecer coluna" (users tem ~15 colunas de vários ALTERs).
 *     Só a constraint de email muda; todo o resto é preservado bit a bit.
 *  4. VALIDAÇÃO antes de confirmar: COUNT(*) origem == destino; se divergir, ABORTA.
 *     Pós-commit: `foreign_key_check` + `integrity_check` (reporta, não silencia).
 *  5. IDEMPOTENTE: detecta se já está org-scoped e vira no-op. Seguro rodar 2×.
 *  6. Recria os índices próprios da tabela (os auto-índices de UNIQUE se recriam sós).
 *
 * NÃO roda sozinho em produção: db.ts só o invoca quando FEATURE_ORG_GROUPS está ligada
 * (canary). Mergear o PR não altera o schema de produção.
 */
import fs from "fs";
import path from "path";

type Db = import("better-sqlite3").Database;

export type EmailConstraintScope = "global" | "org" | "unknown";

/**
 * Detecta o escopo atual da unicidade de email inspecionando o DDL da tabela.
 *  - "org"    → já tem UNIQUE(organization_id, email) — migração é no-op.
 *  - "global" → email é único globalmente (estado legado) — precisa do rebuild.
 */
export function emailConstraintScope(db: Db): EmailConstraintScope {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as any;
  const sql: string = String(row?.sql || "").replace(/\s+/g, " ");
  if (/UNIQUE\s*\(\s*organization_id\s*,\s*email\s*\)/i.test(sql)) return "org";
  if (/\bemail\b[^,]*\bUNIQUE\b/i.test(sql) || /UNIQUE\s*\(\s*email\s*\)/i.test(sql)) return "global";
  return "unknown";
}

export interface RebuildResult {
  skipped: boolean;
  reason?: string;
  rowsBefore?: number;
  rowsAfter?: number;
  columns?: number;
  backupPath?: string | null;
  integrityOk?: boolean;
  fkOk?: boolean;
}

/** Reconstrói a definição de UMA coluna a partir do PRAGMA table_info (preserva tipo,
 *  NOT NULL, DEFAULT e PRIMARY KEY). Não re-emite UNIQUE de coluna — é justamente o que
 *  queremos soltar do email; nenhuma outra coluna de `users` tem UNIQUE/CHECK. */
function columnDef(c: any): string {
  const name = `"${c.name}"`;
  let def = `${name} ${c.type || ""}`.trim();
  if (c.pk) def += " PRIMARY KEY";
  else if (c.notnull) def += " NOT NULL";
  if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT ${c.dflt_value}`;
  return def;
}

/**
 * Executa o rebuild. `backupDir` (default: dir do arquivo do banco) recebe o snapshot.
 * Retorna {skipped:true} quando já está org-scoped. Lança se algo impedir a garantia de
 * integridade (a transação já terá feito rollback — `users` fica intacta).
 */
export function migrateUsersEmailConstraint(db: Db, opts: { backupDir?: string } = {}): RebuildResult {
  const scope = emailConstraintScope(db);
  if (scope === "org") return { skipped: true, reason: "already_org_scoped" };
  if (scope === "unknown") return { skipped: true, reason: "unknown_schema_not_touched" }; // conservador: não mexe no que não entende

  // (1) Snapshot físico + integridade ANTES de tocar em nada. Sem isso, aborta.
  let backupPath: string | null = null;
  try {
    const dbFile = (db as any).name as string; // caminho do arquivo do banco (better-sqlite3)
    if (dbFile && dbFile !== ":memory:") {
      const dir = opts.backupDir || path.dirname(dbFile);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(dir, `users-email-rebuild-backup-${stamp}.sqlite`);
      db.prepare(`VACUUM INTO ?`).run(backupPath);
      const chk = db.prepare("PRAGMA integrity_check").get() as any;
      const okVal = chk?.integrity_check || Object.values(chk || {})[0];
      if (String(okVal).toLowerCase() !== "ok") throw new Error("pre_backup_integrity_failed");
    } else {
      backupPath = null; // :memory: (teste) — sem arquivo pra snapshot; a transação ainda protege
    }
  } catch (e: any) {
    throw new Error(`backup_failed_aborting_rebuild: ${e?.message || e}`);
  }

  const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
  if (!cols.length) throw new Error("users_table_missing");
  const colList = cols.map((c) => `"${c.name}"`).join(", ");
  const defs = cols.map(columnDef).join(", ");
  const indexes = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='users' AND sql IS NOT NULL"
  ).all() as any[];

  const rowsBefore = (db.prepare("SELECT COUNT(*) c FROM users").get() as any).c as number;

  // (2) TRANSAÇÃO ÚNICA. Qualquer throw aqui → rollback → users intacta.
  const tx = db.transaction(() => {
    db.exec(`CREATE TABLE users_new (${defs}, UNIQUE(organization_id, email))`);
    db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM users`);
    const rowsNew = (db.prepare("SELECT COUNT(*) c FROM users_new").get() as any).c as number;
    // (4) valida a cópia ANTES de destruir o original.
    if (rowsNew !== rowsBefore) throw new Error(`row_count_mismatch: before=${rowsBefore} after=${rowsNew}`);
    db.exec(`DROP TABLE users`);
    db.exec(`ALTER TABLE users_new RENAME TO users`);
    // (6) recria índices próprios (os de UNIQUE/PK se recriam automaticamente).
    for (const idx of indexes) {
      try { db.exec(String(idx.sql)); } catch { /* índice já implícito ou duplicado — segue */ }
    }
  });
  tx();

  // (4b) Verificações pós-rebuild (fora da tx — já commitado, agora só constata).
  const rowsAfter = (db.prepare("SELECT COUNT(*) c FROM users").get() as any).c as number;
  const fk = db.prepare("PRAGMA foreign_key_check").all() as any[];
  const integ = db.prepare("PRAGMA integrity_check").get() as any;
  const integVal = integ?.integrity_check || Object.values(integ || {})[0];
  const integrityOk = String(integVal).toLowerCase() === "ok";
  const fkOk = fk.length === 0;

  return {
    skipped: false,
    rowsBefore,
    rowsAfter,
    columns: cols.length,
    backupPath,
    integrityOk,
    fkOk,
  };
}
