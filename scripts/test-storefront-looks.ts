/**
 * TEST — Vitrinista IA: looks de merchandising da loja (ADR-104 Bloco 2).
 *
 * Cobre o motor StorefrontLookService: sugestão a partir das peças novas
 * (caminho determinístico, sem IA), a rede de segurança da validação da IA
 * (payload adversarial), a curadoria do Kanban (criar/editar/mover/remover) e
 * o avanço da curadoria (2ª chamada sem peça nova é recusada).
 *
 * Uso: npm run test:storefront-looks
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-vitrine-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-vitrine-1234567890";
delete process.env.OPENAI_API_KEY;   // força o caminho determinístico (sem IA)
delete process.env.GOOGLE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { StorefrontLookService } = await import("../src/server/StorefrontLookService.js");
  const { InventoryIntakeService } = await import("../src/server/InventoryIntakeService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published) VALUES (?, 'toulon', 1)`).run(orgId);

  // 3 peças elegíveis em categorias diferentes (para o compositor combinar).
  const mk = (name: string, category: string) => {
    const id = InventoryIntakeService.commitProductFromScan(orgId, { name, category, salePrice: 100, marginPercent: 50, quantity: 10, imageUrl: `/media/${name}.jpg` });
    db.prepare(`UPDATE products_services SET fashion_wearable = 1 WHERE id = ?`).run(id); // garante elegibilidade sem depender da heurística/IA
    return id;
  };
  const camisa = mk("Camisa Linho", "Camisas");
  const calca = mk("Calça Alfaiataria", "Calças");
  const cinto = mk("Cinto Couro", "Acessórios");

  // ===== suggest(): compositor determinístico monta looks das peças novas =====
  const r1 = await StorefrontLookService.suggest(orgId);
  check("suggest ok", (r1 as any).ok === true);
  check("suggest criou ao menos 1 look", (r1 as any).ok && (r1 as any).created >= 1);
  check("suggest contou as 3 peças novas", (r1 as any).ok && (r1 as any).newPieceCount === 3);
  const looks1 = (r1 as any).ok ? (r1 as any).looks : [];
  check("todo look tem >= 2 peças", looks1.length > 0 && looks1.every((l: any) => l.items.length >= 2));
  check("looks nascem na coluna 'suggested'", looks1.every((l: any) => l.status === "suggested"));
  check("itens enriquecidos com nome/preço/imagem", looks1[0]?.items?.[0]?.name && looks1[0].items[0].price === 100);

  // ===== 2ª chamada sem peça nova: recusa (curadoria avançou) =====
  const r2 = await StorefrontLookService.suggest(orgId);
  check("2ª suggest recusa (nenhuma peça nova desde a curadoria)", (r2 as any).ok === false && /nenhuma peça nova/i.test((r2 as any).error));

  // ===== validateStoreLooks: rede de segurança (payload adversarial) =====
  const byId = new Map<string, any>([[camisa, { id: camisa, name: "Camisa Linho", category: "Camisas", price: 100, image: null }], [calca, { id: calca, name: "Calça Alfaiataria", category: "Calças", price: 100, image: null }]]);
  const newIds = new Set<string>([camisa]);
  const parsed = {
    looks: [
      { title: "Válido", items: [{ id: camisa, role: "main" }, { id: calca, role: "bottom" }] },     // ok: tem peça nova + 2 itens
      { title: "ID fantasma", items: [{ id: "nao-existe", role: "main" }, { id: calca, role: "bottom" }] }, // sem peça nova (id fantasma descartado) → cortado
      { title: "Só uma peça", items: [{ id: camisa, role: "main" }] },                                // < 2 itens → cortado
      { title: "Sem peça nova", items: [{ id: calca, role: "bottom" }, { id: calca, role: "main" }] }, // dup + sem peça nova → cortado
    ],
  };
  const validated = StorefrontLookService.validateStoreLooks(parsed, byId, newIds, 8);
  check("validate mantém só o look válido", validated.length === 1 && validated[0].title === "Válido");
  check("validate: look válido tem 2 itens", validated[0].items.length === 2);

  // ===== createManual: só IDs elegíveis entram =====
  const cm = StorefrontLookService.createManual(orgId, [camisa, cinto, "bogus"], { title: "Meu look" });
  check("createManual ok", (cm as any).ok === true);
  const manual = (cm as any).ok ? StorefrontLookService.get(orgId, (cm as any).id) : null;
  check("createManual filtra ID inválido (2 itens)", manual?.items?.length === 2);
  check("createManual marca origin=manual", manual?.origin === "manual");
  const cmBad = StorefrontLookService.createManual(orgId, ["bogus1", "bogus2"], {});
  check("createManual sem peça válida → erro", (cmBad as any).ok === false);

  // ===== setItems: substitui as peças =====
  const si = StorefrontLookService.setItems(orgId, (cm as any).id, [calca, cinto]);
  check("setItems ok", (si as any).ok === true);
  check("setItems trocou as peças", StorefrontLookService.get(orgId, (cm as any).id).items.length === 2);

  // ===== update: move de coluna; rejeita status inválido e 'published' =====
  check("update move para approved", (StorefrontLookService.update(orgId, (cm as any).id, { status: "approved" }) as any).ok === true);
  check("look agora em approved", StorefrontLookService.get(orgId, (cm as any).id).status === "approved");
  check("update rejeita 'published' (é do Bloco 3)", (StorefrontLookService.update(orgId, (cm as any).id, { status: "published" }) as any).ok === false);
  check("update rejeita status inválido", (StorefrontLookService.update(orgId, (cm as any).id, { status: "xpto" }) as any).ok === false);

  // ===== list: reflete as colunas; remove apaga =====
  const listed = StorefrontLookService.list(orgId);
  check("list traz looks sugeridos + o manual aprovado", listed.length >= 2 && listed.some((l: any) => l.status === "approved"));
  check("remove apaga o look", StorefrontLookService.remove(orgId, (cm as any).id) === true && !StorefrontLookService.get(orgId, (cm as any).id));
  check("remove some da listagem", !StorefrontLookService.list(orgId).some((l: any) => l.id === (cm as any).id));

  // --- Relatório ---
  console.log("\n=== TEST: Vitrinista IA — looks de vitrine (ADR-104 Bloco 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Vitrinista IA OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
