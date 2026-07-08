/**
 * TESTE — Assinatura digital da NF-e + webhook na fila (ADR-029)
 * ----------------------------------------------------------------
 * Item 29: verificação LOCAL da assinatura XML-DSig da NF-e
 *   - XML assinado de verdade (chave/certificado gerados na hora via openssl,
 *     assinado com o MESMO perfil da NF-e: enveloped, C14N, referência por Id)
 *     -> signed=true, valid=true, certificado extraído;
 *   - XML adulterado depois de assinado -> valid=false (digest não confere);
 *   - XML sem assinatura -> signed=false (não bloqueia, só informa);
 *   - a importação nunca é bloqueada pela assinatura (campo informativo).
 *
 * Item 04: processamento de webhook atrás de flag
 *   - WEBHOOK_QUEUE_ENABLED=false: força o caminho inline (opt-out em produção);
 *   - =true (ou não-set em produção, ver Fase 1 do plano de produção):
 *     enfileira job process_incoming_message com maxAttempts=1 (retry
 *     automático duplicaria resposta da IA ao cliente) e o worker da fila
 *     processa com o MESMO handler.
 *
 * Uso: npm run test:nfe-signature
 */
import os from "os";
import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nfe-sig-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-nfe-signature-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { verifyNFeSignature } = await import("../src/server/nfeSignature.js");
  const { SignedXml } = await import("xml-crypto");

  // ---- item 29 ----
  // chave + certificado autoassinado descartáveis (openssl, só para o teste)
  const keyPath = path.join(tmpDir, "key.pem");
  const certPath = path.join(tmpDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "30", "-nodes", "-subj", "/CN=FORNECEDOR TESTE LTDA"], { stdio: "ignore" });
  const privateKey = fs.readFileSync(keyPath, "utf-8");
  const publicCert = fs.readFileSync(certPath, "utf-8");

  const xml = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe123" versao="4.00"><emit><xNome>Fornecedor Teste</xNome></emit><det nItem="1"><prod><xProd>ITEM</xProd><qCom>1</qCom><vUnCom>5</vUnCom></prod></det></infNFe></NFe>`;

  const signer = new SignedXml({
    privateKey, publicCert,
    signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    canonicalizationAlgorithm: "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
  });
  signer.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
  });
  signer.computeSignature(xml, { location: { reference: "//*[local-name(.)='infNFe']", action: "after" } });
  const signed = signer.getSignedXml();

  const ok = verifyNFeSignature(signed);
  check("XML assinado: signed=true e valid=true", ok.signed === true && ok.valid === true, `error=${ok.error}`);
  check("Certificado extraído (CN do emissor)", ok.certSubject === "FORNECEDOR TESTE LTDA", `subject=${ok.certSubject}`);
  check("Validade do certificado extraída (não expirado)", ok.certExpired === false, `notAfter=${ok.certNotAfter}`);

  const tampered = signed.replace("<xProd>ITEM</xProd>", "<xProd>ITEM ADULTERADO</xProd>");
  const bad = verifyNFeSignature(tampered);
  check("XML adulterado após assinatura: valid=false", bad.signed === true && bad.valid === false);
  check("Falha explica o motivo (digest/assinatura)", !!bad.error);

  const unsigned = verifyNFeSignature(xml);
  check("XML sem assinatura: signed=false (informativo, nunca bloqueia)", unsigned.signed === false && unsigned.valid === null);

  const garbage = verifyNFeSignature("não é xml nenhum");
  check("Entrada inválida não explode (retorna não-assinado)", garbage.signed === false);

  // a rota de importação usa o resultado como INFO, nunca como bloqueio
  const routeSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/products.ts"), "utf-8");
  check("Rota de importação XML anexa o resultado da assinatura ao rascunho/resposta", /verifyNFeSignature/.test(routeSrc));
  check("Nenhum caminho da rota bloqueia importação por assinatura inválida", !/signature\.(valid|signed).*(status\(4|return res)/.test(routeSrc));

  // ---- item 04: webhook atrás de flag ----
  const { JobQueueService } = await import("../src/server/JobQueueService.js");
  const { dispatchIncomingMessage } = await import("../src/server/webhookProcessor.js");
  const { default: db } = await import("../src/server/db.js");

  // registra um handler espião NO LUGAR do real (mesmo type) para não
  // depender de canal/org de verdade — o que se testa aqui é o DESPACHO.
  let inlineCalls = 0;
  let queueJobPayload: any = null;
  (JobQueueService as any).registerHandler("process_incoming_message", async (p: any) => { queueJobPayload = p; return { ok: true }; });

  const fakePayload = { channelId: null, organizationId: null, identifier: "inst1", provider: "evolution" as const, senderId: "5511999999999", text: "oi" };

  // flag explicitamente desligada (=false): força inline — o processador real
  // vai falhar por não achar canal, mas o que importa é que NÃO enfileirou.
  // (Em NODE_ENV=production, o default agora é enfileirar — ver Fase 1 do plano
  // de produção. WEBHOOK_QUEUE_ENABLED=false é o opt-out explícito.)
  process.env.WEBHOOK_QUEUE_ENABLED = "false";
  try { await dispatchIncomingMessage(fakePayload as any, null); inlineCalls++; } catch { inlineCalls++; }
  const jobsAfterInline = db.prepare(`SELECT COUNT(*) AS c FROM background_jobs WHERE type = 'process_incoming_message'`).get() as any;
  check("Flag =false (opt-out explícito): nada é enfileirado (caminho inline preservado)", jobsAfterInline.c === 0 && inlineCalls === 1);

  // flag ligada: enfileira e o worker processa com o handler
  process.env.WEBHOOK_QUEUE_ENABLED = "true";
  await dispatchIncomingMessage(fakePayload as any, null);
  const job = db.prepare(`SELECT * FROM background_jobs WHERE type = 'process_incoming_message' ORDER BY created_at DESC LIMIT 1`).get() as any;
  check("Flag ligada: job process_incoming_message enfileirado", !!job);
  check("Retry desligado no job (maxAttempts=1 — nunca responder 2x o cliente)", job?.max_attempts === 1, `maxAttempts=${job?.max_attempts}`);

  await new Promise((r) => setTimeout(r, 300)); // setImmediate do worker
  check("Worker da fila entregou o payload intacto ao handler", queueJobPayload?.senderId === "5511999999999" && queueJobPayload?.text === "oi");
  delete process.env.WEBHOOK_QUEUE_ENABLED;

  // ---- resultado ----
  console.log("\n=== Assinatura NF-e + webhook na fila (ADR-029) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
