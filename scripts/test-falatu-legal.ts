/**
 * TEST — ADR-154 F2.2 (Fatia D): documentos legais + aceite/consentimento.
 *
 * Cobre o pacote legal do checkout B2C do FalaTu:
 *  1) as 3 páginas existem e servidas em /fala-tu/ com as cláusulas-chave
 *     (Termos, Privacidade LGPD com fluxo p/ Asaas + IA/transferência
 *     internacional, Cancelamento com direito de 7 dias do art. 49 do CDC);
 *  2) o checkout.html tem o checkbox de aceite + links pras 3 páginas;
 *  3) o serviço EXIGE o aceite (terms_not_accepted quando falta);
 *  4) o consentimento é GRAVADO (falatu_terms_version + timestamp) e
 *     AUDITADO (FALATU_TERMS_ACCEPTED com a versão) — prova de consentimento.
 *
 * Asaas via `fetch` STUBADO (sem rede). Uso: npm run test:falatu-legal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const falatuDir = path.join(repoRoot, "public", "fala-tu");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-legal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-legal-123456";
process.env.ASAAS_API_KEY = "asaas-test-key"; // isConfigured() = true
delete process.env.ASAAS_WEBHOOK_TOKEN;
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function read(rel: string): string {
  try { return fs.readFileSync(path.join(falatuDir, rel), "utf8"); } catch { return ""; }
}

// ---- Stub do fetch: encena o Asaas (customer + subscription + payment) ----
(global as any).fetch = async (url: any, init: any) => {
  const method = String(init?.method || "GET").toUpperCase();
  const u = String(url);
  const json = (data: any) => ({ ok: true, status: 200, json: async () => data });
  if (method === "POST" && u.endsWith("/customers")) return json({ id: "cus_legal" });
  if (method === "POST" && u.endsWith("/subscriptions")) return json({ id: "sub_legal" });
  if (method === "GET" && u.includes("/subscriptions/sub_legal/payments"))
    return json({ data: [{ id: "pay_legal", status: "PENDING", value: 19, dueDate: "2026-08-08", invoiceUrl: "https://asaas.test/i/pay_legal" }] });
  return { ok: false, status: 404, json: async () => ({ errors: [{ description: "not stubbed" }] }) };
};

async function main() {
  // ===== 1. Páginas legais existem + cláusulas-chave =====
  const termos = read("termos.html");
  const priv = read("privacidade.html");
  const canc = read("cancelamento.html");

  check("termos.html existe", termos.length > 0);
  check("privacidade.html existe", priv.length > 0);
  check("cancelamento.html existe", canc.length > 0);

  // Marcados como MODELO (não podem ir ao ar como se fossem definitivos).
  check("termos marcado como MODELO/revisar", /MODELO/i.test(termos));
  check("privacidade marcada como MODELO/revisar", /MODELO/i.test(priv));
  check("cancelamento marcado como MODELO/revisar", /MODELO/i.test(canc));

  // Termos: menciona assinatura recorrente + garantia/CDC + limitações da IA.
  check("termos fala de assinatura/pagamento", /assinatura/i.test(termos) && /Asaas/i.test(termos));
  check("termos remete à garantia/cancelamento (art. 49)", /art\.?\s*49/i.test(termos) || /cancelamento\.html/.test(termos));
  check("termos alerta limitações da IA", /intelig[êe]ncia artificial/i.test(termos));
  check("termos linka Privacidade e Cancelamento", /privacidade\.html/.test(termos) && /cancelamento\.html/.test(termos));

  // Privacidade (LGPD): base legal art.7, direitos art.18, Asaas, IA, transferência internacional.
  check("privacidade cita a LGPD", /LGPD|13\.709/i.test(priv));
  check("privacidade lista direitos do titular (art. 18)", /art\.?\s*18/i.test(priv));
  check("privacidade divulga compartilhamento com Asaas", /Asaas/i.test(priv));
  check("privacidade divulga processamento por IA", /(intelig[êe]ncia artificial|OpenAI|modelos? de IA)/i.test(priv));
  check("privacidade divulga transferência internacional", /transfer[êe]ncia internacional/i.test(priv));
  check("privacidade tem contato do encarregado/DPO", /DPO|encarregad/i.test(priv));

  // Cancelamento: direito de arrependimento de 7 dias (CDC art. 49) — casa com guarantee_days:7.
  check("cancelamento cita art. 49 do CDC", /art\.?\s*49/i.test(canc));
  check("cancelamento garante 7 dias", /7\s*\(?sete?\)?\s*dias|7\s*dias|sete\s*dias/i.test(canc));
  check("cancelamento explica interrupção de renovação", /renova/i.test(canc));

  // ===== 2. checkout.html tem checkbox de aceite + links =====
  const checkout = read("checkout.html");
  check("checkout tem checkbox de aceite", /id="accept"/.test(checkout) && /type="checkbox"/.test(checkout));
  check("checkout linka Termos + Privacidade no aceite", /termos\.html/.test(checkout) && /privacidade\.html/.test(checkout));
  check("checkout linka Cancelamento (garantia 7 dias)", /cancelamento\.html/.test(checkout));
  check("checkout envia acceptedTerms no POST", /acceptedTerms/.test(checkout));
  check("checkout bloqueia submit sem aceite", /accept'?\)?\.checked/.test(checkout));

  // ===== 3. Serviço EXIGE o aceite =====
  const { default: db } = await import("../src/server/db.js");
  const { BlueprintSeeder } = await import("../src/server/BlueprintSeeder.js");
  const { FalatuCheckoutService, FALATU_TERMS_VERSION } = await import("../src/server/FalatuCheckoutService.js");
  BlueprintSeeder.seedInitialBlueprints();

  const tryStart = async (input: any) => { try { await FalatuCheckoutService.start(input); return ""; } catch (e: any) { return e.code || "throw"; } };

  const base = { name: "Ana", email: "ana@teste.com", cpf: "39053344705", password: "senha123", planId: "falatu_solo" };
  check("sem acceptedTerms → terms_not_accepted", (await tryStart({ ...base })) === "terms_not_accepted");
  check("acceptedTerms=false → terms_not_accepted", (await tryStart({ ...base, acceptedTerms: false })) === "terms_not_accepted");

  // ===== 4. Consentimento GRAVADO + AUDITADO =====
  const r = await FalatuCheckoutService.start({ ...base, acceptedTerms: true });
  const org = db.prepare(`SELECT falatu_terms_version, falatu_terms_accepted_at, billing_status FROM organization_settings WHERE organization_id = ?`).get(r.organizationId) as any;
  check("grava a versão dos termos aceita", org?.falatu_terms_version === FALATU_TERMS_VERSION);
  check("grava o timestamp do aceite", !!org?.falatu_terms_accepted_at);

  const audit = db.prepare(`SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_TERMS_ACCEPTED'`).get(r.organizationId) as any;
  check("audita FALATU_TERMS_ACCEPTED", !!audit);
  check("auditoria guarda a versão dos termos", !!audit && String(audit.metadata_json || "").includes(FALATU_TERMS_VERSION));

  console.log("");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"} — ${x.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
