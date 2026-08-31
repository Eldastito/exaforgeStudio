#!/usr/bin/env node
/**
 * Gate de lint do ZapFlow Grupo (ADR-199 §7.1 — enforcement do invariante de
 * isolamento). Roda como `npm run test:org-group-lint` (o ci-shard pega dos test:*).
 * Falha o build (exit 1) se:
 *
 *  (R1 · RN-GRP-02) qualquer arquivo em src/server fizer `FROM users WHERE email`
 *      (lookup GLOBAL por email) FORA do AccountIdentityService — o único ponto
 *      autorizado. Isso mantém o login/credencial num chokepoint só, pronto pra
 *      F0c relaxar users.email UNIQUE sem virar lookup ambíguo espalhado.
 *      (Nota: `WHERE organization_id = ? AND email = ?` é org-scoped e SEGURO —
 *      não casa com este padrão.)
 *
 *  (R2 · RN-GRP-05) qualquer *Service.ts org-scoped conhecer o conceito de GRUPO
 *      (group_id / org_group / groupId). O grupo só vive na camada de holding
 *      (allowlist). Nenhum service de negócio pode receber/ler grupo.
 *
 * Determinístico, sem dependência externa. Ignora comentários de linha (`//`) pra
 * não se auto-disparar em documentação — o alvo é CÓDIGO.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "src/server");

// Allowlist R1: só o AccountIdentityService faz o lookup global por email.
const R1_ALLOW = new Set(["AccountIdentityService.ts"]);
// Allowlist R2: a camada de holding/consolidação PODE conhecer grupo.
const R2_ALLOW = new Set(["OrgGroupService.ts", "AccountIdentityService.ts", "GroupConsolidationService.ts"]);

const R1 = /FROM\s+users\s+WHERE\s+email\b/i;             // lookup global por email
const R2 = /\b(group_id|org_group|org_groups|groupId)\b/; // conceito de grupo

/** Remove o conteúdo após `//` (comentário de linha) pra checar só código. */
function stripLineComment(line) {
  const i = line.indexOf("//");
  return i >= 0 ? line.slice(0, i) : line;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  const base = path.basename(file);
  const isService = base.endsWith("Service.ts");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const code = stripLineComment(raw);
    if (!R1_ALLOW.has(base) && R1.test(code)) {
      violations.push({ rule: "R1/RN-GRP-02", file, line: idx + 1, text: raw.trim() });
    }
    if (isService && !R2_ALLOW.has(base) && R2.test(code)) {
      violations.push({ rule: "R2/RN-GRP-05", file, line: idx + 1, text: raw.trim() });
    }
  });
}

if (violations.length) {
  console.error("\n❌ Gate de isolamento do ZapFlow Grupo (ADR-199 §7.1) — violações:\n");
  for (const v of violations) {
    console.error(`  [${v.rule}] ${path.relative(process.cwd(), v.file)}:${v.line}`);
    console.error(`      ${v.text}`);
  }
  console.error(`\n${violations.length} violação(ões). Veja RN-GRP-02/05 no ADR-199.`);
  console.error("R1: lookup global por email só no AccountIdentityService.");
  console.error("R2: nenhum *Service org-scoped conhece grupo (group_id/org_group).\n");
  process.exit(1);
}

console.log("✅ Gate de isolamento do ZapFlow Grupo: OK (RN-GRP-02 + RN-GRP-05).");
