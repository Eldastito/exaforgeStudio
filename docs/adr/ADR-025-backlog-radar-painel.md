# ADR-025 — Backlog Radar painel: recalcular na tela, exclusão de evidência, reenvio de convite e card no painel executivo

**Status:** Implementado e testado (tudo determinístico; envios reais de WhatsApp/e-mail validados só até a camada de validação, como na ADR-017 — nenhuma chamada de rede em teste).
**Origem:** pacote 2 do levantamento de pendências — itens 01, 13, 15, 17 e 23 do backlog aprovado pelo usuário.

## Item 01 — Toggle do módulo Radar: JÁ ESTAVA RESOLVIDO (backlog desatualizado)

As ADRs 009/010/012 registraram "ativar o módulo exige chamada direta à API". A investigação desta rodada encontrou que trabalho posterior já tinha resolvido: `SettingsView.tsx` lista `{ key: 'radar', label: 'Radar de Execução IA' }` em `OPTIONAL_MODULES`, com o fluxo completo (carrega de `GET /api/analytics/settings`, salva via `POST /api/analytics/settings/modules` → `ModuleService.setModules`). **Nenhum código novo foi escrito para este item** — em vez disso, o teste novo comprova o toggle de ponta a ponta (entrada presente na tela + round-trip `setModules`/`isEnabled`), para o backlog nunca mais reabrir esse item por engano. Lição registrada: item de backlog antigo precisa ser re-verificado contra o código atual antes de virar trabalho.

## Item 13 — Botão "Recalcular score" (a lacuna era só de UI)

`POST /api/radar/sessions/:id/recalculate` existia desde a ADR-013 sem nenhum botão que o chamasse. Agora a tela de resultado (`RadarView.tsx`) mostra "Recalcular score" para managers quando a sessão está em `awaiting_review` — o caso real de uso: anexou/excluiu evidência ou revisou respostas depois de concluir, quer o número atualizado sem aprovar ainda. A sessão retornada atualiza a tela na hora (estado local sincronizado com a prop, sem voltar pra lista).

## Item 15 — Exclusão de evidência (`DELETE /sessions/:id/evidence/:evidenceId`)

A parte delicada não é o DELETE — é **desfazer o boost de confiança** corretamente. Anexar evidência sobe a resposta para 0,90 (ADR-015); excluir a ÚLTIMA evidência de uma resposta devolve a confiança ao patamar declarado que ela teria sem evidência, pela mesma régua de `saveAnswer`: 0,50 ("não sei"), 0,75 (com comentário), 0,60 (sem). Com outra evidência restante na mesma resposta, 0,90 permanece. O score da sessão é recalculado na hora (`calculateAndPersist`), o evento `radar_evidence_removed` é auditado, e o arquivo físico local é apagado best-effort pela rota (a linha do banco é a fonte de verdade — mesmo contrato do upload).

Permissão deliberadamente assimétrica: **upload é de qualquer usuário da organização** (quem respondeu anexa a própria evidência, ADR-015), **exclusão é manager-only** — excluir mexe no score, é ação de curadoria de quem revisa o diagnóstico. O botão aparece para todos na tela (lixeira ao lado do anexo); quem não for owner/admin recebe o 403 com a mensagem do servidor.

## Item 17 — Reenvio de convite de respondente

Restrição de design herdada da ADR-018: o banco guarda só o **hash** do token — o link original é irrecuperável por design. Logo, "reenviar" é sempre **rotacionar**: `POST /sessions/:id/respondents/:respondentId/resend` gera token novo, invalida o anterior (inclusive um link vazado — rotação dobra como recurso de segurança) e renova os 30 dias. Respostas já dadas pelo link antigo ficam preservadas (são por `respondent_id`, não por token).

Três canais: `link` (só devolve o link novo — mostrado uma única vez, igual à criação), `email` (via `GoogleOAuthService.gmailSend`, mesma infra da ADR-017) e `whatsapp` (via `MessageProviderService.sendMessage`, com telefone informado na hora — `radar_respondents` não guarda telefone). Regra importante: **a validação do canal roda ANTES da rotação** — se o envio não tem para onde ir (sem conexão Google, sem canal WhatsApp, sem telefone), o token atual continua válido; o respondente nunca fica com o link morto por causa de uma falha de envio. Convite revogado ou respondente concluído não reenviam. Auditoria: `radar_respondent_invite_resent`. Na tela: botões "Novo link" / "E-mail" (quando há e-mail) / "WhatsApp" (abre mini-campo de telefone) ao lado do "Revogar".

## Item 23 — Card do Radar Score no painel executivo

`GET /api/radar/latest-score` devolve o score da sessão pontuada mais recente (`awaiting_review`/`approved`/`completed` com `overall_maturity_score` preenchido — rascunho nunca aparece) ou `{ score: null }`. O `DashboardPanel` consome em modo melhor-esforço: módulo Radar desabilitado (403 do gate de módulos) ou sem sessão pontuada simplesmente não mostram o card — o painel executivo nunca quebra por causa do Radar. O card (faixa horizontal abaixo dos 4 KPIs, mesma linguagem visual) mostra o score /100, o status ("aguardando revisão" vs. "concluído") e a data.

## Validação

`npm run test:backlog-radar-panel` (27 verificações novas) + suíte completa (18 scripts, 345 verificações, zero quebras):
- Toggle: entrada presente no `SettingsView` + round-trip `setModules`/`isEnabled`.
- Exclusão de evidência: única evidência excluída → 0,60/0,75 conforme comentário; evidência restante → 0,90 permanece; `removedFileUrl` devolvido; auditoria por exclusão; re-exclusão rejeitada; isolamento entre organizações.
- Reenvio: hash rotacionado e novo token validado contra o novo hash; falha de canal NÃO rotaciona; e-mail sem Google e WhatsApp sem telefone rejeitados com mensagens claras; revogado não reenvia; isolamento entre organizações; auditoria.
- latest-score: null sem sessão pontuada; rascunho invisível; sessão concluída aparece com score/sessionId; isolado por organização.
- Recalcular: devolve sessão com score; isolamento entre organizações.
- `npm run lint` e `npm run build` limpos.

**Não coberto em teste** (mesma ressalva da ADR-017): o envio real por WhatsApp/e-mail — os testes validam até a camada de validação de canal; `MessageProviderService`/`GoogleOAuthService` são infra já em produção para o envio de relatório.
