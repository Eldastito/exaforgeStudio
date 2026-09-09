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
| F1 | F1.1–F1.4 | **EM ANDAMENTO** | F1.3 (`test:evolution-reset` 14/14) + F1.1-credencial (`test:evolution-credential` 6/6) | G1 (falta F1.2/F1.4 + normalização de ID/eventos) |
| F2 | F2.1–F2.4 | NÃO INICIADO | — | G2 |
| F3 | F3.1–F3.4 | NÃO INICIADO | — | G3 |
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
- [ ] **F1.2** — Empresa, webhook protegido e estados corretos. — **EM ANDAMENTO** (sub-fatias). **F1.2a IMPLEMENTADO**: dedup do inbound Meta/Cloud + Instagram (achado X2/INV-02) — o handler `/api/webhooks/meta` chama `claimWebhookEvent(provider, wamid|mid)` antes de despachar; retry da Meta não reprocessa (sem duplicar contato/ticket/resposta). `test:meta-webhook-dedup` 10/10; regressões `security-webhook` 12/12, `security-tenant` 7/7, `channel-health`, `delivery-receipts` verdes. **Faltam:** F1.2b (validar JID antes de virar telefone, X3), F1.2c (fim do `default_org` + estados provados, A8/A9), webhook assinado/URL protegida (A10).
- [ ] **F1.3** — Provisionamento idempotente; sessão protegida contra reset automático. — **IMPLEMENTADO** (removido o delete+recreate silencioso de `connectAndGetQr`; capacidade preservada em `resetInstance` EXPLÍCITO/operador; retorno honesto `needsReset`. `test:evolution-reset` 14/14; regressão `test:falatu-solo-whatsapp` 72/72. VALIDADO vira `[x]` quando a suíte rodar no CI + a rota/UI de reset da Fase 2 expor a operação com confirmação).
- [ ] **F1.4** — Rotas legadas e Solo compatíveis com a fundação comum. — NÃO INICIADO

### Fase 2 — Conexão autônoma e configuração dos usos
- [ ] **F2.1** — Importação/criação/QR/retomada disponíveis na UI existente. — NÃO INICIADO
- [ ] **F2.2** — Usos por funcionalidade e resolvedor aplicados no backend. — NÃO INICIADO
- [ ] **F2.3** — Preferências migradas sem habilitação indiscriminada. — NÃO INICIADO
- [ ] **F2.4** — Fluxo móvel e bloqueio de pendências ao desligar validados. — NÃO INICIADO

### Fase 3 — Identidade e conversa interna unificadas
- [ ] **F3.1** — Identidade e permissão unificadas, incluindo perguntas abertas. — NÃO INICIADO
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
