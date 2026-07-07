/**
 * TEST — Filosofia consultiva ("Ferrari") aplicada aos 3 prompts das IAs de venda:
 * atendimento/vendas, negociador ativo e autonomia da IA (reserva+pagamento).
 *
 * Verifica que os textos-chave do método estão presentes conforme o toggle
 * correto (negociador, autonomia) e que continuam funcionando com os toggles
 * desligados (regressão de comportamento default).
 *
 * Uso: npm run test:ferrari-philosophy-prompts
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ferrari-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ferrari-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");

  const seedOrg = (tag: string, patch: Record<string, any> = {}) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    for (const [col, val] of Object.entries(patch)) {
      try { db.prepare(`UPDATE organization_settings SET ${col} = ? WHERE organization_id = ?`).run(val, id); } catch { /* noop */ }
    }
    return id;
  };

  // Acesso interno: usamos any-cast para chamar buildPrompt privado. Isso é ok
  // no teste porque estamos validando o formato do prompt gerado.
  const AI = AIOrchestratorService as any;

  // Só de agente 'attendance_agent' vamos ver as regras de venda.
  const buildFor = (orgId: string, extras: any = {}) => AI.buildPrompt(
    "attendance_agent",
    { organizationId: orgId, message: "oi", senderId: "5511900000000", ticketStage: "novo_lead", ...extras },
    "", "produto teste", "", "", "", extras.negotiatorText || "", "", "", "", "", "", "", "", "", ""
  );

  // ==== 1. Postura consultiva (regra-mãe) ====
  console.log("\n=== 1. Postura consultiva base ===");
  const orgDefault = seedOrg("default");
  const promptDefault = buildFor(orgDefault);

  check("1.1 Menciona 'POSTURA CONSULTIVA'", /POSTURA CONSULTIVA/.test(promptDefault));
  check("1.2 Menciona reatância psicológica ('pressão' → 'defesa'/'resiste')", /pressão/i.test(promptDefault) && /(defesa|resist)/i.test(promptDefault));
  check("1.3 Ordem 'necessidade → desejo → valor → preço' presente", /despertar percepção/i.test(promptDefault) && /valor percebido/i.test(promptDefault));
  check("1.4 Diz que fechamento é 'consequência natural'", /consequência natural/i.test(promptDefault));

  // ==== 2. Despertar de necessidades ====
  console.log("\n=== 2. Despertar de necessidades ===");
  check("2.1 Regra 'DESPERTAR A NECESSIDADE' existe", /DESPERTAR A NECESSIDADE/.test(promptDefault));
  check("2.2 Instrui perguntas descobridoras antes de apresentar solução", /O que te levou a procurar/i.test(promptDefault));
  check("2.3 Explicita 'apresentar solução antes de despertar = perder venda'", /perder a venda/i.test(promptDefault));

  // ==== 3. Fechamento sem pressão ====
  console.log("\n=== 3. Fechamento sem pressão ===");
  check("3.1 FECHAMENTO reformulado como consequência", /FECHAMENTO POR CONSEQU/.test(promptDefault));
  check("3.2 Pergunta de decisão em vez de venda", /Faz sentido a gente seguir/.test(promptDefault));
  check("3.3 Instrui 'NÃO force' quando cliente não pronto", /NÃO force/i.test(promptDefault));

  // ==== 4. Negociador com filosofia consultiva ====
  console.log("\n=== 4. Negociador com filosofia consultiva ===");
  const orgNeg = seedOrg("negotiator");
  db.prepare(`UPDATE organization_settings SET negotiator_enabled = 1, negotiator_max_discount = 15 WHERE organization_id = ?`).run(orgNeg);
  // Semeia um produto com min_price para o negociador ter algo pra listar.
  const p1 = randomUUID();
  try {
    db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, min_price, active) VALUES (?, ?, 'product', 'Camiseta', 100, 80, 1)`).run(p1, orgNeg);
  } catch { /* noop */ }
  const negText = AI.negotiatorContext(orgNeg);
  check("4.1 negotiatorContext gera texto quando ligado", typeof negText === "string" && negText.length > 100);
  check("4.2 Menciona 'postura consultiva'", /consultiva/i.test(negText));
  check("4.3 Menciona reatância / não 'convencer' com pressão", /reatância/i.test(negText) && /pressão/i.test(negText));
  check("4.4 Instrui percepção de valor ANTES do preço", /PERCEP[CÇ][ÃA]O DE VALOR ANTES/i.test(negText));
  check("4.5 Rejeita ‘vamos fechar’ e prefere ‘o que ainda precisa’", /vamos fechar/i.test(negText) && /precisa para se sentir seguro/i.test(negText));
  check("4.6 Reciprocidade / algo em troca do desconto", /troca/i.test(negText));
  check("4.7 Preserva regra de limite máximo de desconto (15%)", negText.includes("15%"));
  check("4.8 Continua devolvendo string vazia quando desligado", AI.negotiatorContext(seedOrg("neg-off")) === "");

  // ==== 5. Autonomia da IA nas vendas ====
  console.log("\n=== 5. Autonomia (reserva estoque + confirma pagamento) ===");
  const orgAuto = seedOrg("auto");
  db.prepare(`UPDATE organization_settings SET ai_auto_close_sales = 1 WHERE organization_id = ?`).run(orgAuto);
  const promptAuto = buildFor(orgAuto);
  check("5.1 Bloco 'AUTONOMIA DE VENDAS ATIVA' aparece quando ligada", /AUTONOMIA DE VENDAS ATIVA/.test(promptAuto));
  check("5.2 Reserva descrita como SERVIÇO, não pressão", /RESERVA COMO SERVIÇO/i.test(promptAuto));
  check("5.3 Não use 'corre para pagar antes que acabe'", /NÃO diga "reservei aqui, corre para pagar/i.test(promptAuto));
  check("5.4 Confirmação de pagamento como celebração, não venda", /CONFIRMA[ÇC][ÃA]O DE PAGAMENTO como celebração/i.test(promptAuto));
  check("5.5 Silêncio após PIX = NÃO cutucar", /SILÊNCIO APÓS PIX/i.test(promptAuto) && /reatância/i.test(promptAuto));
  check("5.6 Fluxo elegante quando PIX expira", /NÃO transforme em cobrança/i.test(promptAuto));

  const orgAutoOff = seedOrg("auto-off");
  const promptAutoOff = buildFor(orgAutoOff);
  check("5.7 Bloco de autonomia NÃO aparece quando desligada", !/AUTONOMIA DE VENDAS ATIVA/.test(promptAutoOff));

  // ==== 6. Regressão: comportamento existente preservado ====
  console.log("\n=== 6. Regressão ===");
  check("6.1 Regras já existentes 'VOU PENSAR' seguem no prompt", /VOU PENSAR/.test(promptDefault));
  check("6.2 CLASSIFIQUE E TRATE OBJEÇÕES continua", /CLASSIFIQUE E TRATE OBJE/.test(promptDefault));
  check("6.3 INTELIGÊNCIA COMERCIAL (sales_intelligence) continua", /INTELIG[ÊE]NCIA COMERCIAL/.test(promptDefault));
  check("6.4 CANCELAMENTO continua", /CANCELAMENTO/.test(promptDefault));
  check("6.5 PREÇO NUNCA ISOLADO continua", /PRE[ÇC]O NUNCA ISOLADO/.test(promptDefault));

  console.log("\n──── Resultados ────");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
