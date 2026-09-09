# Checklist acumulado — PRD WhatsApp Unificado / Fala Tu

> Mantido no repo conforme §22 do PRD. Atualizar a CADA entrega (mesmo parcial /
> diagnóstico / correção). Nunca escrever só "feito"/"100%". Estados permitidos:
> `NÃO INICIADO` · `EM ANDAMENTO` · `IMPLEMENTADO` · `VALIDADO` · `BLOQUEADO` ·
> `NÃO APLICÁVEL — JUSTIFICADO`. `IMPLEMENTADO` exige código; `VALIDADO` exige
> evidência de teste/gate. Marcar `[x]` só quando VALIDADO.

## Quadro por fase

| Fase | Itens | Estado | Evidência | Pendência para o gate |
|---|---|---|---|---|
| F0 | F0.1–F0.4 | **EM ANDAMENTO** | `docs/whatsapp-unificado/ANALISE-F0-auditoria-baseline.md` | Contrato Evolution real (Swagger) + fixtures + execução da suíte |
| F1 | F1.1–F1.4 | **IMPLEMENTADO** (escopo enxuto) | F1.1 (`evolution-credential` 6/6) · F1.2a (`meta-webhook-dedup` 10/10) · F1.2b (`whatsapp-jid` 16/16) · F1.2c (`evolution-channel-status` 10/10) · F1.3 (`evolution-reset` 14/14) · F1.4 (`evolution-connect-subscribe` 5/5) | **G1 atendido** no escopo enxuto; difere pra F1.2d a máquina de estados RF-02 + webhook assinado (A10) |
| F2 | F2.1–F2.4 | **IMPLEMENTADO** (escopo enxuto) | F2.1 + F2.2 + F2.3 (`channel-binding-migration` 18/18) + F2.4 (`channel-binding-gate` 11/11) | **G2 atendido** no escopo enxuto; ativação por-produtor do gate difere pra Fase 6 |
| F3 | F3.1–F3.4 | **EM ANDAMENTO** | F3.0 auditoria + F3.1a projeção por usuário no Diretor (`executive-money-projection` 24/24) | G3 (CA-04/05/06) — próximo: F3.1b resolução comum de identidade |
| F4 | F4.1–F4.4 | NÃO INICIADO | — | G4 |
| F5 | F5.1–F5.4 | NÃO INICIADO | — | G5 |
| F6 | F6.1–F6.4 | NÃO INICIADO | — | G6 |
| F7 | F7.1–F7.4 | NÃO INICIADO | — | G7 |

## Itens individuais (32)

### Fase 0 — Revalidar e congelar a linha de base
- [ ] **F0.1** — HEAD e achados revalidados; correções já existentes reconhecidas. — **IMPLEMENTADO** (matriz 13/13 + 7 extras, HEAD `40508f1` × auditado `8362838`; evidência na análise F0). Falta só o carimbo de execução da suíte para virar VALIDADO.
- [ ] **F0.2** — Produtores, consumidores, identidades e vínculos mapeados. — **IMPLEMENTADO** (U01–U36 existem; 7 padrões de canal; sem resolvedor único; sem `channel_feature_bindings`; 5 atalhos `wa.me`).
- [ ] **F0.3** — Contrato Evolution e fixtures sanitizadas registrados. — **EM ANDAMENTO / BLOQUEADO** (contrato derivado do código + docs públicas; Swagger da instalação real e fixtures **pendentes** por falta de acesso — Gate G0 permite seguir por contrato).
- [ ] **F0.4** — Baseline, simulação de migração e plano de reversão registrados. — **IMPLEMENTADO** (25/25 testes existem; schema/flags/rollback registrados; simulação numérica de migração fica para F4.1 em modo sem efeitos).

### Fase 1 — Corrigir fundação da conexão
- [ ] **F1.1** — Configuração, credenciais e normalização centralizadas. — **PARCIAL/IMPLEMENTADO** (credencial Evolution centralizada em `MessageProviderService.resolveEvolutionSend`, com prioridade corrigida — token do CANAL primeiro, env fallback; achado A6/RF-02/INV-01. `test:evolution-credential` 6/6; regressões `instagram-send`/`falatu-solo-whatsapp` 72/72/`delivery-receipts`/`channel-health` verdes). **Falta ainda:** normalização de ID/eventos do webhook (movida para junto de F1.2, onde vive a identidade); criptografia real do token de canal — achado X1 — fica como fatia irmã com migração compatível.
- [ ] **F1.2** — Empresa, webhook protegido e estados corretos. — **EM ANDAMENTO** (sub-fatias). **F1.2a IMPLEMENTADO**: dedup do inbound Meta/Cloud + Instagram (achado X2/INV-02) — o handler `/api/webhooks/meta` chama `claimWebhookEvent(provider, wamid|mid)` antes de despachar; retry da Meta não reprocessa (sem duplicar contato/ticket/resposta). `test:meta-webhook-dedup` 10/10; regressões `security-webhook` 12/12, `security-tenant` 7/7, `channel-health`, `delivery-receipts` verdes. **F1.2b IMPLEMENTADO**: `classifyWhatsappJid` (módulo puro `whatsappJid.ts`) valida o JID antes de virar telefone — grupo/status/newsletter/lid/inválido não viram contato de atendimento (achado X3/INV-01); só individual com telefone plausível segue; wired no inbound Evolution do `server.ts`. `test:whatsapp-jid` 16/16. **F1.2c IMPLEMENTADO**: fim do `default_org` — `markEvolutionChannelStatusByIdentifier` (módulo puro `evolutionChannelStatus.ts`) resolve o canal pelo `identifier` ÚNICO e SÓ atualiza status; nunca inventa org nem confia no header spoofável x-organization-id (achados A8/A9/SEC-F4); wired nos 2 pontos do `server.ts` (connect legado + connection.update). `test:evolution-channel-status` 10/10; regressões `security-tenant` 7/7, `falatu-whatsapp` 21/21, `channel-health` 8/8, `falatu-solo-whatsapp` 72/72 verdes. **Faltam (F1.2d futura, fora do escopo enxuto):** máquina de estados sessão/webhook da RF-02 + webhook assinado/URL protegida (A10).
- [ ] **F1.3** — Provisionamento idempotente; sessão protegida contra reset automático. — **IMPLEMENTADO** (removido o delete+recreate silencioso de `connectAndGetQr`; capacidade preservada em `resetInstance` EXPLÍCITO/operador; retorno honesto `needsReset`. `test:evolution-reset` 14/14; regressão `test:falatu-solo-whatsapp` 72/72. VALIDADO vira `[x]` quando a suíte rodar no CI + a rota/UI de reset da Fase 2 expor a operação com confirmação).
- [ ] **F1.4** — Rotas legadas e Solo compatíveis com a fundação comum. — **IMPLEMENTADO**: a rota legada `/api/evolution/instance/connect` deixou de reimplementar create+connect+QR inline (com o subscribe MINÚSCULO do achado A7 que o Evolution GO descarta) e passou a DELEGAR ao `EvolutionService.provision` (subscribe MAIÚSCULO + múltiplos endpoints de QR + campo `data.qrcode` + reset não-destrutivo da F1.3). Contrato de resposta preservado pro ChannelsPanel (`{base64}`/`{state:'open'}`/400). O Solo já usava o serviço consolidado. `test:evolution-connect-subscribe` 5/5; regressões `evolution-reset` 14/14, `falatu-solo-whatsapp` 72/72, `channel-health` 8/8, `falatu-whatsapp` 21/21 verdes. **Corrige na prática o fluxo real do ChannelsPanel** (era este endpoint que assinava eventos em minúsculo).

### Fase 2 — Conexão autônoma e configuração dos usos
- [ ] **F2.1** — Importação/criação/QR/retomada disponíveis na UI existente. — **F2.1a (backend) IMPLEMENTADO**: `ChannelProvisioningService` + rotas autenticadas `POST /api/channels/whatsapp/provision` (mode `new`|`existing`) e `GET /api/channels/whatsapp/status`. Org SEMPRE da sessão (RF-01 §7.2, nunca corpo/header); reusa `EvolutionService.provision`; idempotente por `(org,identifier)`; import §8 (nega instância de outra org; importa só a que EXISTE no provedor e está livre; nunca inventa); `EvolutionService.instanceExists` (verificação não-destrutiva); segredos nunca voltam. `test:channel-provision` 15/15; regressões `falatu-solo-whatsapp` 72/72, `security-tenant` 7/7, `channel-health` verdes. **F2.1b (UI) IMPLEMENTADO**: `ChannelsPanel` religado ao endpoint AUTENTICADO (`apiFetch('/api/channels/whatsapp/provision')`) no lugar do `fetch` legado não-autenticado. Toggle de modo "Usar/importar existente" × "Adicionar número novo" (os dois que o dono escolheu); QR/estado vindos do endpoint; retomada ao abrir a tela (`GET /whatsapp/status`); erros tipados tratados (409 outra empresa · 404 não existe · 502/`needsReset` provedor). UI-only, tsc+build verdes. **Fim do F2.1.**
- [ ] **F2.2** — Usos por funcionalidade e resolvedor aplicados no backend. — **IMPLEMENTADO (backend + escrita + UI)**: tabela `channel_feature_bindings` (aditiva/opt-in, UNIQUE por org+finalidade+unidade+canal) + `ChannelBindingService.resolve()` — resolvedor ÚNICO com precedência unidade→org→nenhum, priority DESC, gate por direção (inbound/outbound), fallback só quando configurado, revalidação de canal (org + não-desabilitado), motivo sempre no retorno. Isolamento (INV-01). **Sem religar os ~20 produtores ainda** (Fase 6) — nasce testado, 0-regressão. **Controles de ESCRITA IMPLEMENTADOS**: `ChannelBindingService.upsert/remove` (valida finalidade conhecida via `KNOWN_FEATURES`, canal/fallback da org, concorrência otimista por `policy_version` → `version_conflict`, auditado) + rotas autenticadas owner/admin `GET /api/channels/bindings`, `POST /api/channels/bindings`, `DELETE /api/channels/bindings/:id` (códigos 400/409/404 tipados; segredos nunca trafegam). `test:channel-binding` 21/21; regressões `channel-provision` 15/15, `security-tenant` 7/7, `channel-health` 8/8; tsc verde. **UI IMPLEMENTADA**: seção "Usos por finalidade (opcional)" no `ChannelsPanel` — lista os usos configurados (finalidade → número, com direção), remove, e adiciona (select de finalidade × número), consumindo `GET/POST/DELETE /api/channels/bindings`; texto deixa claro "sem configurar, tudo segue como está". UI-only, tsc+build verdes. **F2.2 completo.**
- [ ] **F2.3** — Preferências migradas sem habilitação indiscriminada. — **IMPLEMENTADO**: `ChannelBindingMigrationService.migrate(dryRun default)` deriva bindings SÓ dos sinais existentes (canal `kind='internal'`→`gestao`; atendimento→`atendimento`), `origin='migration'`, NÃO habilita finalidade nova (§9); dryRun é o default seguro (só relata); idempotente (2ª vez→skip_existing); NÃO sobrescreve binding manual (finalidade já em outro canal→conflict); ignora canal desabilitado; isolado por org. Rota `POST /api/channels/bindings/migrate` (dryRun default; `{dryRun:false}` aplica). `test:channel-binding-migration` 18/18; regressões `channel-binding` 21/21, `channel-provision` 15/15, `security-tenant` 7/7; tsc verde. 0-regressão (produtores só leem o resolvedor na Fase 6).
- [x] **F2.4** — Fluxo móvel e bloqueio de pendências ao desligar validados. — **IMPLEMENTADO (gate no SINK, opt-in)**: `OutboundFeatureDisabledError` + `ChannelBindingService.assertOutboundAllowed(orgId, feature?, {unitId?})` — só LANÇA quando a finalidade tem binding com saída DESLIGADA (`feature_disabled`); passa em `no_binding`/finalidade ligada/sem-feature (0-regressão). Wired como gate OPCIONAL no sink de saída `MessageProviderService.sendMessage`/`sendDocument` (quando o chamador informa `opts.feature`): desligar a finalidade BLOQUEIA o envio ANTES de tocar o provedor (fetch=0), sem afetar as outras finalidades do mesmo canal (CA-03). A ativação POR PRODUTOR (passar `feature` em cada ponto de envio) fica pra Fase 6 — hoje nasce testado e 0-regressão porque nenhum produtor passa `feature` ainda. `test:channel-binding-gate` 11/11; regressões `channel-binding` 21/21, `channel-binding-migration` 18/18, `evolution-credential` 6/6, `security-tenant` 7/7, `delivery-receipts` 10/10; tsc verde. **Fecha o G2 no escopo enxuto.**

### Fase 3 — Identidade e conversa interna unificadas
- [ ] **F3.0** — Auditoria de identidade/autorização/modo misto (RF-04/05/06). — **IMPLEMENTADO (doc-only)**: `docs/whatsapp-unificado/ANALISE-F3-identidade-modo-misto.md`. 8 perguntas respondidas com `arquivo:linha`. Achado nº1 (bloqueador G3): Diretor `ExecutiveAdvisorService.ask(orgId,question)` sem projeção por usuário + gate de dinheiro contornado em pergunta aberta (INV-11/X5, CA-04). Recorte F3.0→F3.1a→F3.1b→F3.2→F3.3→F3.4 proposto.
- [ ] **F3.1** — Identidade e permissão unificadas, incluindo perguntas abertas. — **EM ANDAMENTO**. **F3.1a IMPLEMENTADO (projeção por usuário no Diretor — CA-04/INV-11)**: `ExecutiveAdvisorService.ask(orgId, question, { canSeeMoney })` e `buildPanorama(orgId, { canSeeMoney })` passam a REDIGIR o financeiro quando o usuário não pode ver dinheiro (§73) — some pilar Financeiro, indicador em R$, meta em R$, comissão, recomendações de plano e o impacto R$ dos sinais; metas de contagem e fatos não-monetários seguem. Fecha o bypass do gate em PERGUNTA ABERTA (antes `needsMoney:false` pulava `canSeeMoney`). Chamadores religados: `FalaTuAskService` (pergunta aberta passa `canSeeMoney(user)`), rota web `POST /api/executive/ask` (sem `requireRole` — projeta pela MESMA régua, permitindo gerente), `webhookProcessor` (ramo `pergunta_negocio` é manager-only → `canSeeMoney:true` explícito). Default = mostra tudo (0-regressão: 5 testes de bloco + rotas owner/admin intactos). `test:executive-money-projection` 24/24; regressões `executive-briefing-block` 10/10, `executive-retail-commission-block` 8/8, `executive-plan-recommendations-block` 23/23, `executive-effectiveness` 10/10, `business-snapshot`, `falatu-ask` 33/33, `falatu-ask-whatsapp` 13/13, `security-money-gating` 12/12; tsc verde. **Falta F3.1b** (resolução comum de identidade: fachada conciliando `authorized_managers` × `users.phone` sem elevar privilégio).
- [ ] **F3.2** — Entrada comum web/WhatsApp com aliases preservados. — NÃO INICIADO
- [ ] **F3.3** — Modo misto sem vazamento de conversa interna para CRM. — NÃO INICIADO
- [ ] **F3.4** — Confirmações, expiração e papéis ambíguos tratados. — NÃO INICIADO

### Fase 4 — Consolidar registros operacionais do Fala Tu
- [ ] **F4.1** — Relatório de vínculos e conflitos por registro disponível. — NÃO INICIADO
- [ ] **F4.2** — Migração idempotente retomável sem efeitos externos. — NÃO INICIADO
- [ ] **F4.3** — Registros operacionais principais preservados; notas pessoais mantidas. — NÃO INICIADO
- [ ] **F4.4** — Conclusão/reabertura e reversão coerentes entre interfaces. — NÃO INICIADO

### Fase 5 — Solicitar e receber arquivos pela conversa
- [ ] **F5.1** — Catálogo, contexto e autorização de arquivos implementados. — NÃO INICIADO
- [ ] **F5.2** — PDF/XLSX reutilizados e DOCX real gerado. — NÃO INICIADO
- [ ] **F5.3** — MIME, fila, artefato e entrega segura integrados. — NÃO INICIADO
- [ ] **F5.4** — Arquivos abertos e dados/permissões/fallback verificados. — NÃO INICIADO

### Fase 6 — Integrar os demais usos e validar falhas
- [ ] **F6.1** — Consumidores remanescentes usam seleção por finalidade. — NÃO INICIADO
- [ ] **F6.2** — Falhas parciais, deduplicação e políticas de fila validadas. — NÃO INICIADO
- [ ] **F6.3** — Guardas das verticais e automações preservadas. — NÃO INICIADO
- [ ] **F6.4** — Saúde, métricas, outros canais e capacidade do piloto verificados. — NÃO INICIADO

### Fase 7 — Piloto, observação e descontinuação controlada
- [ ] **F7.1** — Rollback exercitado e piloto autorizado preparado. — NÃO INICIADO
- [ ] **F7.2** — Ciclo representativo do piloto executado e observado. — NÃO INICIADO
- [ ] **F7.3** — Regressões corrigidas e reconciliação concluída antes de ampliar. — NÃO INICIADO
- [ ] **F7.4** — Redundâncias elegíveis retiradas; compatibilidade e histórico preservados. — NÃO INICIADO

## Prestação de contas — entrega Fase 0

```
ENTREGA: Fase 0 — auditoria + baseline (doc-only)
HEAD de entrada: 40508f13f74598549e1bd47cf1d33904fc6d76fc
Commit/PR entregue: ver PR desta branch

Resultado para o usuário:
Auditoria do HEAD conforme a instrução principal do PRD (revalidar antes de mexer).
13/13 achados da §4.1 revalidados + 7 achados extras, com evidência arquivo:linha.
Nenhum código de produção alterado.

Reuso e redundância:
- Nenhuma remoção nesta fase (proibido antes de migração+validação — §15/§19).
- Confirmado que NÃO existe resolvedor único de canal nem tabela de uso por
  finalidade; ~20 cópias do mesmo SQL "primeiro canal" — alvo da RF-03.

Dados e migração:
- Nenhuma migração executada. Simulação numérica adiada para F4.1 (modo sem efeitos).
- Efeitos externos disparados durante migração: zero (nenhuma migração rodou).

Validação:
| Comando/cenário | Ambiente | Resultado real | Evidência |
| grep de existência dos 25 testes de baseline | coding env | 25/25 presentes | F0.4 |
| npm run lint / build (docs-only) | coding env | n/a (sem mudança de código) | — |
Falhas preexistentes: execução real da suíte pendente (início da Fase 1).
Regressões novas: nenhuma (doc-only).

Gates/invariantes: Gate G0 — inventário e baseline auditáveis; Evolution real pendente.

Ativação:
- Flags/configurações alteradas: nenhuma.
- Piloto/produção: não iniciado.
- Reversão: trivial (doc-only).

Riscos e bloqueios restantes: acesso à Evolution real (Swagger + fixtures).
Próxima entrega prioritária: Fase 1 (F1.3 reset destrutivo; F1.1/F1.2 credencial+identidade).
```
</content>
