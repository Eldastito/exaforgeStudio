/**
 * TEST — Consultora Jurídica (ADR-115): orientação ancorada no CDC, com
 * grounding estrito (não inventa lei), disclaimer obrigatório e isolamento.
 *
 * Roda SEM chave de IA (a recuperação é determinística e a composição cai no
 * texto curado por artigo) — igual ao restante do CI.
 *
 * Uso: npm run test:legal-advisor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-legal-1234567890";
delete process.env.OPENAI_API_KEY; // garante o caminho frugal (sem LLM)

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { LegalAdvisorService: L } = await import("../src/server/LegalAdvisorService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const nums = (a: { numero: string }[]) => a.map((x) => x.numero);

  // ===== 1. Defeito no produto → art. 18 (garantia legal) =====
  const a1 = await L.ask(orgId, "Cliente comprou e o produto veio com defeito, sou obrigado a devolver o dinheiro na hora?");
  check("defeito → recupera o art. 18", a1.grounded && nums(a1.artigos).includes("18"));
  check("defeito → orientação fala em 30 dias/conserto", /30 dias|conserto|trocar/i.test(a1.orientacao));

  // ===== 2. Compra pela internet → art. 49 (arrependimento 7 dias) =====
  const a2 = await L.ask(orgId, "Cliente comprou pela internet e quer devolver sem defeito, tenho que aceitar?");
  check("internet → recupera o art. 49", a2.grounded && nums(a2.artigos).includes("49"));
  check("internet → orientação cita 7 dias", /7 dias|sete dias/i.test(a2.orientacao));

  // ===== 3. Cobrança de fiado → art. 42 (sem constranger) =====
  const a3 = await L.ask(orgId, "Como faço para cobrar um cliente que ficou devendo no fiado?");
  check("cobrança → recupera o art. 42", a3.grounded && nums(a3.artigos).includes("42"));
  check("cobrança → orienta NÃO expor/constranger", /constrang|expor|particular|corte|dobro/i.test(a3.orientacao));

  // ===== 4. Menção direta ao número do artigo =====
  const a4 = await L.ask(orgId, "o que diz o artigo 51 sobre placa de não trocamos?");
  check("menção direta 'artigo 51' recupera o art. 51", nums(a4.artigos).includes("51"));

  // ===== 5. Grounding: fora do CDC → recusa honesta (não inventa) =====
  const a5 = await L.ask(orgId, "Qual é a capital da França e como faço um bolo de cenoura?");
  check("fora do domínio → grounded=false", a5.grounded === false);
  check("fora do domínio → não cita artigo", a5.artigos.length === 0);
  check("fora do domínio → admite que não encontrou amparo", /não encontrei amparo/i.test(a5.orientacao));

  // ===== 6. Disclaimer obrigatório em TODA resposta =====
  check("disclaimer presente (com amparo)", /não substitui um advogado/i.test(a1.disclaimer));
  check("disclaimer presente (sem amparo)", /não substitui um advogado/i.test(a5.disclaimer));
  check("fonte/versão do CDC vêm na resposta", a1.fonte === "cdc" && typeof a1.versao === "string" && a1.versao.length > 0);

  // ===== 7. Top-K limita a 3 artigos =====
  const a7 = await L.ask(orgId, "produto com defeito, prazo para reclamar, arrependimento, cobrança e oferta");
  check("recuperação limita a no máximo 3 artigos", a7.artigos.length <= 3 && a7.artigos.length >= 1);

  // ===== 8. Auditoria por org (isolamento) =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  const cntOrg = (o: string) => (db.prepare("SELECT COUNT(*) c FROM legal_consultations WHERE organization_id=?").get(o) as any).c;
  check("consultas auditadas na org certa", cntOrg(orgId) >= 5);
  check("isolamento: outra org sem consultas", cntOrg(other) === 0);
  const groundedRow = db.prepare("SELECT grounded FROM legal_consultations WHERE organization_id=? AND articles LIKE '%42%' LIMIT 1").get(orgId) as any;
  check("auditoria guarda grounded + artigos", groundedRow && groundedRow.grounded === 1);

  // ===== 9. Perguntas sugeridas disponíveis =====
  check("há perguntas sugeridas para a UI", L.suggestedTopics().length >= 4);

  // ===== 10. Ganchos proativos por situação (Fatia 2) =====
  const cob = L.forSituation("cobranca_fiado", orgId);
  check("situação cobranca_fiado existe", !!cob);
  check("cobrança proativa cita o art. 42", !!cob && cob.artigos.some((a) => a.numero === "42"));
  check("cobrança proativa orienta não constranger", !!cob && /particular|constrang|expor|ameac/i.test(cob.dica));
  check("cobrança proativa traz disclaimer", !!cob && /não substitui um advogado/i.test(cob.disclaimer));

  const dev = L.forSituation("devolucao_troca", orgId);
  check("situação devolucao_troca cita art. 18 e 49", !!dev && dev.artigos.some((a) => a.numero === "18") && dev.artigos.some((a) => a.numero === "49"));

  check("situação inexistente retorna null", L.forSituation("inexistente_xyz", orgId) === null);
  check("lista de situações disponível para a UI", L.situations().length >= 3 && L.situations().some((s) => s.key === "cobranca_fiado"));
  // A dica proativa também é auditada (grounded=1).
  const cobAudit = db.prepare("SELECT COUNT(*) c FROM legal_consultations WHERE organization_id=? AND question LIKE '[situação]%'").get(orgId) as any;
  check("dica proativa registrada na auditoria", cobAudit.c >= 2);

  // ===== 11. Base ampliada: súmulas do STJ e PROCON (Fatia 3) =====
  const aSum = await L.ask(orgId, "preciso notificar o cliente antes de colocar o nome dele no serasa?");
  check("negativação → recupera a Súmula 359 do STJ", aSum.artigos.some((a: any) => a.fonte === "sumula_stj" && a.numero === "359"));
  check("citação traz o rótulo (ref) por fonte", aSum.artigos.some((a: any) => /Súmula 359 do STJ/.test(a.ref)));

  const aProcon = await L.ask(orgId, "fui notificado pelo procon, o que eu faço?");
  check("PROCON → recupera orientação da fonte procon", aProcon.grounded && aProcon.artigos.some((a: any) => a.fonte === "procon"));

  const aCharge = await L.ask(orgId, "o cliente fez chargeback e contestou a compra no cartão");
  check("chargeback → recupera orientação (grounded)", aCharge.grounded && aCharge.artigos.length >= 1);

  // Súmula 130 (estacionamento) — cobertura da base ampliada.
  const aEstac = await L.ask(orgId, "responsabilidade por furto de veículo no meu estacionamento");
  check("furto no estacionamento → Súmula 130 do STJ", aEstac.artigos.some((a: any) => a.numero === "130" && a.fonte === "sumula_stj"));

  // Situações novas (Fatia 3).
  check("situação reclamacao_procon existe e cita procon", (() => { const s = L.forSituation("reclamacao_procon", orgId); return !!s && s.artigos.some((a: any) => a.fonte === "procon"); })());
  check("situação chargeback existe", !!L.forSituation("chargeback", orgId));
  check("base ampliada tem mais normas que só o CDC", (L.baseInfo().normas || 0) > (L.baseInfo().artigos || 0));

  // ===== 12. Histórico por tema (Fatia 3) =====
  const hist = L.history(orgId);
  check("histórico conta as consultas reais (exclui situações)", hist.total >= 8);
  check("histórico agrega temas com contagem", hist.temas.length >= 1 && hist.temas[0].count >= 1);
  check("histórico traz rótulo legível por tema", typeof hist.temas[0].ref === "string" && hist.temas[0].ref.length > 0);
  check("histórico separa recusadas (fora do domínio)", hist.recusadas >= 1);
  const histOther = L.history(other);
  check("histórico isolado por org", histOther.total === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Consultora Jurídica (ADR-115) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Consultora Jurídica OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
