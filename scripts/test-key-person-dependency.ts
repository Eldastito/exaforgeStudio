/**
 * TEST — Key-Person Dependency (ADR-190 §38, CEO Operating Layer). Detecta risco de
 * CONCENTRAÇÃO (single-point-of-failure): receita num vendedor / atendimentos num
 * responsável. Read-only, derivado por query; o alerta HIGH vai pra ESPINHA
 * (business_signals) e flui pro snapshot/constraint — nunca tabela paralela.
 *
 * Cobre: sem dado → insufficient_data (não inventa risco) · 1 pessoa → não sinaliza ·
 * concentração alta → high + share correto · detect publica na espinha (hipótese, R$
 * null) · self-healing (concentração alivia → resolve) · dinheiro role-gated · fluxo
 * pro snapshot/constraint · isolamento.
 *
 * Uso: npm run test:key-person-dependency
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-keyperson-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-keyperson-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { KeyPersonDependencyService: K } = await import("../src/server/KeyPersonDependencyService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ExecutiveConstraintService } = await import("../src/server/ExecutiveConstraintService.js");

  const seedOrder = (org: string, seller: string, amount: number) =>
    db.prepare(`INSERT INTO orders (id, organization_id, seller_user_id, total_amount, status, created_at) VALUES (?, ?, ?, ?, 'pago', datetime('now','-10 day'))`).run(randomUUID(), org, seller, amount);

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── 1. Sem dado → insufficient_data (honesto, não inventa risco) ──
  const a0 = K.assess(A);
  check("1.1 sem vendas → revenue insufficient_data", a0.dimensions.find((d) => d.dimension === "revenue")?.risk === "insufficient_data");
  check("1.2 sem risco (hasRisk false)", a0.hasRisk === false);

  // ── 2. UMA pessoa só (mesmo carregando 100%) → não é "dependência" a sinalizar ──
  for (let i = 0; i < 8; i++) seedOrder(A, "vendedor_solo", 100);
  const a1 = K.assess(A);
  check("2.1 1 participante → insufficient_data (não sinaliza solo)", a1.dimensions.find((d) => d.dimension === "revenue")?.risk === "insufficient_data");

  // ── 3. Concentração ALTA: topo com ~87.5% da receita (2+ pessoas, volume ok) ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja B', 'active')`).run(randomUUID(), B);
  for (let i = 0; i < 7; i++) seedOrder(B, "estrela", 1000); // 7000
  seedOrder(B, "outro", 1000);                                // 1000 → total 8000, topo 87.5%
  const b1 = K.assess(B);
  const rev = b1.dimensions.find((d) => d.dimension === "revenue")!;
  check("3.1 risco high", rev.risk === "high");
  check("3.2 share ≈ 87.5%", Math.abs((rev.topShare ?? 0) - 87.5) < 0.5);
  check("3.3 topo = estrela, 2 participantes", rev.topActorId === "estrela" && rev.participants === 2);
  check("3.4 basis fact (concentração é medida)", rev.basis === "fact");

  // ── 4. detect publica na ESPINHA (hipótese, R$ null — nunca inventa dinheiro) ──
  const d1 = K.detect(B);
  check("4.1 detect publicou 1 sinal", d1.published === 1);
  const sig = BusinessSignalService.attention(B).items.find((i: any) => i.type === "key_person_risk");
  check("4.2 sinal na espinha (attention)", !!sig);
  check("4.3 impacto R$ null (não inventa dinheiro)", sig?.impactAmount === null);
  check("4.4 basis estimate (risco é hipótese, não fato de perda)", sig?.basis === "estimate");

  // ── 5. Flui pro snapshot/constraint SOZINHO (composição, sem superfície nova) ──
  const con = ExecutiveConstraintService.assess(B);
  check("5.1 aparece como exceção do pilar operações", con.pillarsRanked.some((p) => p.pillar === "operations" && p.criticalCount + p.riskCount > 0));

  // ── 6. Self-healing: concentração alivia → detect resolve o sinal ──
  for (let i = 0; i < 7; i++) seedOrder(B, "outro", 1000); // agora outro tem 8000, estrela 7000 → topo ~53%... ainda medium? topo=outro 8000/15000=53.3% → medium
  const b2 = K.assess(B);
  check("6.1 concentração aliviou (não mais high)", b2.dimensions.find((d) => d.dimension === "revenue")?.risk !== "high");
  const d2 = K.detect(B);
  check("6.2 detect resolveu o sinal (self-healing)", d2.resolved >= 1 && d2.published === 0);
  check("6.3 sinal não está mais aberto", !BusinessSignalService.attention(B).items.some((i: any) => i.type === "key_person_risk"));

  // ── 7. Dinheiro role-gated: includeMoney false não expõe R$ ──
  for (let i = 0; i < 7; i++) seedOrder(B, "estrela2", 5000); // reconcentra pra ter high de novo
  const withMoney = K.assess(B, { includeMoney: true }).dimensions.find((d) => d.dimension === "revenue")!;
  const noMoney = K.assess(B, { includeMoney: false }).dimensions.find((d) => d.dimension === "revenue")!;
  check("7.1 includeMoney expõe R$", typeof withMoney.totalAmount === "number");
  check("7.2 sem includeMoney não expõe R$ (share % permanece)", noMoney.totalAmount === undefined && typeof noMoney.topShare === "number");

  // ── 8. Isolamento ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja C', 'active')`).run(randomUUID(), C);
  check("8.1 org C sem dados → insufficient_data", K.assess(C).hasRisk === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} key-person-dependency: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
