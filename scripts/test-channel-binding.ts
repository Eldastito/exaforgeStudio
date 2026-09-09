/**
 * TEST — F2.2: resolvedor único de canal por finalidade
 * (PRD WhatsApp Unificado — RF-03 / CA-03).
 *
 * Prova, offline (tmp db):
 *  - precedência unidade → org → nenhum;
 *  - priority DESC desempata no mesmo escopo;
 *  - inbound/outbound gate por direção; finalidade desligada não resolve;
 *  - fallback só quando configurado (e revalidado);
 *  - canal desabilitado/de outra org nunca é escolhido (isolamento);
 *  - sem binding → no_binding (comportamento herdado, não "chuta" canal).
 *
 * Uso: npm run test:channel-binding
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cfb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cfb-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string, name: string, status = "connected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', ?, ?, ?)`).run(id, org, name, name, status);
    return id;
  };
  const bind = (org: string, channelId: string, feature: string, o: { unitId?: string | null; inbound?: number; outbound?: number; priority?: number; fallback?: string | null } = {}) => {
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, unit_id, inbound, outbound, priority, fallback_channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, channelId, feature, o.unitId ?? null, o.inbound ?? 1, o.outbound ?? 1, o.priority ?? 0, o.fallback ?? null);
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const chAtend = mkChannel(A, "atendimento");
  const chCamp = mkChannel(A, "campanhas");
  const chUnit = mkChannel(A, "loja2");

  // ── 1. sem binding → no_binding (herdado) ──
  check("1.1 sem binding → no_binding", ChannelBindingService.resolve(A, "atendimento").code === "no_binding");

  // ── 2. regra da org resolve ──
  bind(A, chAtend, "atendimento");
  const r2 = ChannelBindingService.resolve(A, "atendimento", { direction: "outbound" });
  check("2.1 org resolve → chAtend, scope org", r2.ok && r2.channelId === chAtend && r2.scope === "org");

  // ── 3. precedência: unidade vence org ──
  bind(A, chUnit, "atendimento", { unitId: "loja2" });
  const r3 = ChannelBindingService.resolve(A, "atendimento", { unitId: "loja2" });
  check("3.1 unidade vence org", r3.ok && r3.channelId === chUnit && r3.scope === "unit");
  const r3b = ChannelBindingService.resolve(A, "atendimento", { unitId: "loja9" });
  check("3.2 unidade sem regra própria → cai na org", r3b.ok && r3b.channelId === chAtend && r3b.scope === "org");

  // ── 4. priority DESC desempata no mesmo escopo ──
  const chAtend2 = mkChannel(A, "atendimento2");
  bind(A, chAtend2, "atendimento", { priority: 10 });
  const r4 = ChannelBindingService.resolve(A, "atendimento");
  check("4.1 maior priority vence", r4.ok && r4.channelId === chAtend2);

  // ── 5. direção: só inbound ──
  bind(A, chCamp, "campanhas", { inbound: 0, outbound: 1 });
  check("5.1 outbound resolve", ChannelBindingService.resolve(A, "campanhas", { direction: "outbound" }).ok === true);
  check("5.2 inbound desligado → feature_disabled", ChannelBindingService.resolve(A, "campanhas", { direction: "inbound" }).code === "feature_disabled");

  // ── 6. fallback só quando configurado ──
  const chDisabled = mkChannel(A, "quebrado", "disabled");
  const chFb = mkChannel(A, "reserva");
  bind(A, chDisabled, "cobranca", { fallback: chFb });
  const r6 = ChannelBindingService.resolve(A, "cobranca");
  check("6.1 canal principal desabilitado → usa fallback configurado", r6.ok && r6.channelId === chFb && r6.scope === "fallback");

  // ── 7. canal indisponível sem fallback → channel_unavailable ──
  const chDead = mkChannel(A, "morto", "disabled");
  bind(A, chDead, "agenda");
  check("7.1 sem fallback e canal off → channel_unavailable", ChannelBindingService.resolve(A, "agenda").code === "channel_unavailable");

  // ── 8. isolamento: binding aponta pra canal de OUTRA org → não resolve ──
  const chB = mkChannel(B, "outra");
  // força um binding cruzado inválido em A apontando pro canal de B
  db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key) VALUES (?, ?, ?, 'gestao')`).run(randomUUID(), A, chB);
  const r8 = ChannelBindingService.resolve(A, "gestao");
  check("8.1 canal de outra org nunca resolve", r8.ok === false && r8.channelId === null);
  // e B não vê os bindings de A
  check("8.2 B não tem bindings de A", ChannelBindingService.list(B).length === 0);

  // ── 9. WRITE controls: upsert cria, valida finalidade, concorrência, remove ──
  const chW = mkChannel(A, "para-uso");
  const u1 = ChannelBindingService.upsert(A, "op1", { channelId: chW, featureKey: "recompra" });
  check("9.1 upsert cria (policyVersion 1)", u1.ok === true && u1.policyVersion === 1 && !!u1.id);
  check("9.2 finalidade desconhecida rejeitada", ChannelBindingService.upsert(A, "op1", { channelId: chW, featureKey: "xpto" }).code === "invalid_feature");
  check("9.3 canal de outra org rejeitado", ChannelBindingService.upsert(A, "op1", { channelId: chB, featureKey: "recompra" }).code === "channel_not_in_org");
  // re-upsert mesma chave → atualiza + bump de versão
  const u2 = ChannelBindingService.upsert(A, "op1", { channelId: chW, featureKey: "recompra", priority: 5 });
  check("9.4 re-upsert atualiza + bump policyVersion→2", u2.ok === true && u2.policyVersion === 2);
  // concorrência otimista: ifPolicyVersion antigo → conflito
  check("9.5 ifPolicyVersion antigo → version_conflict", ChannelBindingService.upsert(A, "op1", { channelId: chW, featureKey: "recompra", ifPolicyVersion: 1 }).code === "version_conflict");
  // ifPolicyVersion correto → aplica
  check("9.6 ifPolicyVersion correto → aplica (→3)", ChannelBindingService.upsert(A, "op1", { channelId: chW, featureKey: "recompra", ifPolicyVersion: 2, priority: 7 }).policyVersion === 3);
  // o resolvedor enxerga o que foi gravado
  check("9.7 resolve enxerga o binding escrito", ChannelBindingService.resolve(A, "recompra").channelId === chW);
  // remove
  check("9.8 remove ok", ChannelBindingService.remove(A, "op1", u1.id!).ok === true);
  check("9.9 remove idempotente/ausente → not_found", ChannelBindingService.remove(A, "op1", u1.id!).code === "not_found");
  check("9.10 após remover, recompra volta a no_binding", ChannelBindingService.resolve(A, "recompra").code === "no_binding");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-binding: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
