/**
 * TESTE — WZ-1: comando "gere uma imagem…" pelo WhatsApp de gestão.
 * ------------------------------------------------------------------------------
 * Prova, offline (deps injetadas — sem IA/rede):
 *   - parser DETERMINÍSTICO (RN-151): verbo+«imagem» com briefing/formato;
 *     pergunta aberta e "anota …" NÃO são interceptadas;
 *   - fluxo feliz: avisa "gerando" → chama o Estúdio com o briefing → envia a
 *     imagem NATIVA com URL absoluta (APP_URL) + legenda;
 *   - honestidade: sem briefing pergunta; erro do Estúdio (limite do plano)
 *     repassa a mensagem real; envio nativo falhou → link DECLARADO; sem
 *     APP_URL → aponta pro Estúdio (nunca manda link quebrado);
 *   - fiação: webhookProcessor chama o serviço ANTES do Controller.
 *
 * Uso:  npm run test:studio-whatsapp-command
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-studio-cmd-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-studio-cmd-1234567890";
delete process.env.APP_URL;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { StudioWhatsAppCommandService: Svc } = await import("../src/server/StudioWhatsAppCommandService.js");

  // ── 1) Parser puro ──
  const p1 = Svc.parse("Zapp, gere uma imagem de um vestido azul em promoção");
  check("1.1 comando com prefixo Zapp → generate_image", p1.intent === "generate_image");
  check("1.2 briefing extraído sem o conectivo", p1.briefing === "um vestido azul em promoção", p1.briefing);
  check("1.3 formato default post", p1.format === "post");
  const p2 = Svc.parse("gera imagem story do café da manhã");
  check("1.4 formato story detectado", p2.intent === "generate_image" && p2.format === "story" && p2.briefing === "café da manhã", `${p2.format}|${p2.briefing}`);
  check("1.5 sem briefing → ask_briefing", Svc.parse("faça uma imagem").intent === "ask_briefing");
  check("1.6 pergunta aberta NÃO intercepta", Svc.parse("como foram as vendas hoje?").intent === "none");
  check("1.7 'anota comprar imagem nova' NÃO intercepta (verbo não é de geração)", Svc.parse("anota comprar imagem nova").intent === "none");
  check("1.8 'crie uma arte banner com look de inverno' casa", (() => { const p = Svc.parse("crie uma arte banner com look de inverno"); return p.intent === "generate_image" && p.format === "banner" && p.briefing === "look de inverno"; })());

  // ── 2) Fluxo feliz (deps injetadas; APP_URL setada) ──
  process.env.APP_URL = "https://app.zapflow.test";
  const calls: any[] = [];
  const deps = {
    generate: async (orgId: string, briefing: string, format: string) => { calls.push(["generate", orgId, briefing, format]); return { id: "c1", mediaUrl: "/media/studio_x.png", prompt: briefing }; },
    sendImage: async (cid: string, to: string, url: string, cap?: string) => { calls.push(["sendImage", cid, to, url, cap]); },
    sendMessage: async (cid: string, to: string, msg: string) => { calls.push(["sendMessage", cid, to, msg]); },
  };
  const r2 = await Svc.handle("orgA", "ch1", "5521999", "Zapp, gere uma imagem de tênis branco", deps as any);
  check("2.1 handled + outcome sent", r2.handled === true && r2.outcome === "sent");
  check("2.2 avisou 'gerando' antes", calls.some(c => c[0] === "sendMessage" && /Gerando/i.test(c[3])));
  const gen = calls.find(c => c[0] === "generate");
  check("2.3 Estúdio chamado com org+briefing", gen?.[1] === "orgA" && gen?.[2] === "tênis branco");
  const img = calls.find(c => c[0] === "sendImage");
  check("2.4 imagem enviada com URL ABSOLUTA", img?.[3] === "https://app.zapflow.test/media/studio_x.png", img?.[3]);
  check("2.5 legenda carrega o briefing", /tênis branco/.test(img?.[4] || ""));

  // ── 3) Honestidade ──
  const calls3: any[] = [];
  const depsErr = { ...deps, sendMessage: async (...a: any[]) => { calls3.push(a); }, generate: async () => { throw new Error("Limite de imagens do plano atingido (10/10 este mês)."); } };
  const r3 = await Svc.handle("orgA", "ch1", "5521999", "gere uma imagem de bolsa vermelha", depsErr as any);
  check("3.1 erro do Estúdio → outcome error", r3.outcome === "error");
  check("3.2 mensagem REAL do plano repassada", calls3.some(a => /Limite de imagens do plano/.test(a[2])));

  const calls4: any[] = [];
  const depsFb = { ...deps, sendMessage: async (...a: any[]) => { calls4.push(a); }, sendImage: async () => { throw new Error("evolution off"); } };
  const r4 = await Svc.handle("orgA", "ch1", "5521999", "gere uma imagem de bolsa vermelha", depsFb as any);
  check("4.1 envio nativo falhou → fallback de LINK declarado", r4.outcome === "link_fallback" && calls4.some(a => /https:\/\/app\.zapflow\.test\/media\//.test(a[2])));

  delete process.env.APP_URL;
  const calls5: any[] = [];
  const deps5 = { ...deps, sendMessage: async (...a: any[]) => { calls5.push(a); }, sendImage: async (...a: any[]) => { calls5.push(["IMG", ...a]); } };
  const r5 = await Svc.handle("orgA", "ch1", "5521999", "gere uma imagem de bolsa vermelha", deps5 as any);
  check("5.1 sem APP_URL → aponta pro Estúdio (não tenta anexar nem manda link quebrado)", r5.outcome === "no_app_url" && !calls5.some(a => a[0] === "IMG") && calls5.some(a => /Estúdio de Criação/.test(a[2])));

  const r6 = await Svc.handle("orgA", "ch1", "5521999", "qual o saldo de hoje?", deps as any);
  check("6.1 não-comando → handled:false (segue pro Controller/Diretor)", r6.handled === false);

  // ── 7) Fiação: o webhookProcessor chama o serviço ANTES do Controller ──
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/webhookProcessor.ts"), "utf8");
  const iStudio = src.indexOf("StudioWhatsAppCommandService.handle");
  const iGestor = src.indexOf("GestorCommandService.handle");
  check("7.1 runInternalInbound chama o Estúdio antes do Controller", iStudio > 0 && iGestor > 0 && iStudio < iGestor);

  console.log("\n=== TEST: Comando de imagem via WhatsApp (WZ-1) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
