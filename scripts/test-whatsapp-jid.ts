/**
 * TEST — F1.2b: validação de JID de WhatsApp antes de virar telefone
 * (PRD WhatsApp Unificado — achado X3 / RF-04 / INV-01).
 *
 * O inbound do Evolution fazia `split('@')[0].split(':')[0]` cego: grupo,
 * status/broadcast, newsletter e LID viravam "remetente" falso e criavam
 * contato/ticket espúrio. `classifyWhatsappJid` só devolve senderId quando é um
 * contato INDIVIDUAL com telefone plausível.
 *
 * Uso: npm run test:whatsapp-jid
 */
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { classifyWhatsappJid, isIndividualWhatsappJid } = await import("../src/server/whatsappJid.js");

  // ── individual: passa e normaliza ──
  check("1.1 s.whatsapp.net → individual + telefone", (() => { const c = classifyWhatsappJid("5521999998888@s.whatsapp.net"); return c.kind === "individual" && c.senderId === "5521999998888"; })());
  check("1.2 remove sufixo de device (:NN)", classifyWhatsappJid("5521999998888:12@s.whatsapp.net").senderId === "5521999998888");
  check("1.3 c.us também é individual", classifyWhatsappJid("5521999998888@c.us").kind === "individual");
  check("1.4 número cru (sem @) → individual", (() => { const c = classifyWhatsappJid("5521999998888"); return c.kind === "individual" && c.senderId === "5521999998888"; })());

  // ── não-individuais: NÃO viram telefone ──
  check("2.1 grupo @g.us → group, senderId vazio", (() => { const c = classifyWhatsappJid("120363000000000000@g.us"); return c.kind === "group" && c.senderId === ""; })());
  check("2.2 status@broadcast → broadcast", classifyWhatsappJid("status@broadcast").kind === "broadcast");
  check("2.3 @broadcast → broadcast", classifyWhatsappJid("123@broadcast").kind === "broadcast");
  check("2.4 @newsletter → newsletter", classifyWhatsappJid("120363111@newsletter").kind === "newsletter");
  check("2.5 @lid → lid", classifyWhatsappJid("99887766@lid").kind === "lid");

  // ── inválidos: vazio, telefone implausível, domínio desconhecido ──
  check("3.1 vazio → invalid", classifyWhatsappJid("").kind === "invalid");
  check("3.2 null → invalid", classifyWhatsappJid(null).kind === "invalid");
  check("3.3 muito curto (<8 dígitos) → invalid", classifyWhatsappJid("12345@s.whatsapp.net").kind === "invalid");
  check("3.4 muito longo (>15 dígitos) → invalid", classifyWhatsappJid("1234567890123456@s.whatsapp.net").kind === "invalid");
  check("3.5 domínio desconhecido com número plausível → invalid (não confia)", classifyWhatsappJid("5521999998888@desconhecido.xyz").kind === "invalid");
  check("3.6 local não-numérico em domínio individual → invalid", classifyWhatsappJid("abc@s.whatsapp.net").kind === "invalid");

  // ── atalho isIndividual ──
  check("4.1 isIndividual true só pra individual", isIndividualWhatsappJid("5521999998888@s.whatsapp.net") === true && isIndividualWhatsappJid("120363@g.us") === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} whatsapp-jid: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
