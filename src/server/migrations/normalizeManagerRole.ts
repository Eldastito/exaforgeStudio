import db from "../db.js";

/**
 * Migração idempotente: normaliza `users.role = 'manager'` → `'admin'`.
 *
 * PORQUÊ: "manager" era gravado como rótulo de gerente de loja, mas NENHUM gate
 * do sistema o reconhecia (requireRole só conhece owner/admin/agent; o fallback
 * RBAC mapeia owner/admin/agent; as checagens de front testam role==='admin').
 * Resultado: um usuário "manager" tomava 403 nas ~centenas de rotas
 * requireRole("owner","admin") e caía no perfil mais restrito no fallback RBAC —
 * só funcionava se tivesse o perfil "Gerente" atribuído. O papel de gerente de
 * loja É "admin" da sua loja (confinado por tenant); a distinção fina vive no
 * PERFIL RBAC "Gerente", não no papel.
 *
 * Bump de `security_version` em cada linha convertida REVOGA o token antigo (que
 * ainda claim role='manager') — o usuário reloga já com o papel correto (SEC-F7).
 *
 * Idempotente: só toca linhas com role='manager'; roda no boot; segura o caso de
 * a coluna/segurança não existir (legado) sem derrubar o boot.
 */
export function normalizeManagerRole(): { converted: number } {
  let converted = 0;
  try {
    const rows = db.prepare("SELECT id FROM users WHERE role = 'manager'").all() as any[];
    if (!rows.length) return { converted: 0 };
    const upd = db.prepare("UPDATE users SET role = 'admin' WHERE id = ?");
    const bump = db.prepare("UPDATE users SET security_version = COALESCE(security_version, 1) + 1 WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of rows) {
        upd.run(r.id);
        try { bump.run(r.id); } catch { /* coluna security_version pode não existir em legado */ }
        converted++;
      }
    });
    tx();
    if (converted) console.log(`[RBAC] Normalizados ${converted} usuário(s) role 'manager' → 'admin'.`);
  } catch (e) {
    console.error("[RBAC] Falha ao normalizar role 'manager':", e);
  }
  return { converted };
}
