# Roteiro do ciclo representativo do piloto (F7.2)

> **F7.2 (RF §21 / Gate G7).** Roteiro de **observação** do ciclo representativo
> para a empresa piloto (TOULON) + o **ensaio offline** que o antecede. **Doc +
> teste.** Não liga nada em produção: habilitar o piloto por org/canal, usar os
> números autorizados e abrir a janela de observação é **decisão do dono**.
>
> **Estado honesto (Gate G7):** o ciclo está **provado localmente em ensaio**
> (`npm run test:piloto-ciclo-representativo`, com o conjunto de flags do piloto
> LIGADO num banco isolado). A observação do **ciclo real** é **pendente** — só
> vira `VALIDADO` depois de executada e aprovada pelo dono.

## 0. Onde F7.2 se encaixa (§598)

A ordem do rollout é: **(1) staging com fixtures → (2) dados de migração
representativos → (3) número de teste autorizado → (4) empresa piloto → (5)
ampliação**. Este documento cobre **(1)** com o ensaio automatizado (offline,
sem enviar mensagem) e prepara **(3)/(4)** com o roteiro de observação abaixo.
O runbook `whatsapp-unificado-piloto.md` (F7.1) cobre a **ativação por flag** e
o **rollback**; este cobre **o que exercitar e o que observar** uma vez ligado.

## 1. Pré-condição: ensaio offline verde (staging, §598.1)

Antes de tocar o número autorizado, rodar o ensaio — prova que o ciclo é
**exercitável e observável** com o conjunto de flags do piloto ligado, sem
efeito externo:

```
npm run test:piloto-ciclo-representativo
```

O ensaio dirige os quatro trilhos do ciclo (atendimento · gestão · automação
agendada · arquivos) numa org com **todas as flags do piloto LIGADAS** e
confere que as **três superfícies de observação** refletem a atividade de forma
coerente, e que **nada vaza** para uma segunda org com as flags desligadas.

## 2. O ciclo representativo — quatro trilhos a exercitar

Exercitar, com os **números autorizados**, cada trilho e conferir a superfície
correspondente. Anotar contra a **baseline** (§600 do runbook).

| # | Trilho | O que fazer (nº autorizado) | Esperado | Anomalia = interromper (§602) |
|---|---|---|---|---|
| 2.1 | **Atendimento** | Cliente (desconhecido) manda mensagem no canal comercial | Vira atendimento/CRM normalmente; IA responde conforme hoje | Cliente NÃO cria atendimento, ou mensagem interna vira ticket de CRM |
| 2.2 | **Gestão** | Gestor (número reconhecido) manda comando pelo MESMO número comercial (modo misto ligado) | Roteia para gestão (Coordenador/Diretor/Fala Tu); **não** cria lead/ticket; dinheiro só para quem pode ver (§73) | Gestor vira ticket de cliente; ou dado financeiro exposto a quem não pode ver |
| 2.3 | **Automação agendada** | Deixar rodar uma automação diária real (ex.: lembrete de agenda, cadência de cobrança) na janela | Sai pela finalidade certa; **desligar a finalidade** silencia SÓ ela, sem afetar as outras do mesmo canal (CA-03) | Automação ignora finalidade desativada; ou some finalidade não desligada |
| 2.4 | **Arquivos** | Pedir um relatório pela conversa e depois "me manda isso em Excel/Word" | Os 3 formatos abrem e trazem o mesmo dado/período; sem permissão → não recebe conteúdo nem link (CA-07) | Arquivo abre com dado de outra permissão/empresa; ou DOCX é PDF renomeado |

A janela de observação deve **cobrir as automações diárias relevantes**
(lembretes, cadências, digests) — não só um envio pontual (§600).

## 3. Superfícies de observação (sem token, read-only)

Durante e ao fim da janela, comparar contra a baseline:

- `GET /api/falatu/whatsapp-health` — por canal, **qual etapa** (connection ·
  queue · send_permanent · send_unknown · ok) + contadores por classe + idade de
  fila + ação de recuperação (CA-10). Nenhum segredo trafega.
- `GET /api/channels/states` — as 4 dimensões lógicas (sessão · webhook ·
  administração · operação). Webhook só "healthy" após evento real; rejeitado
  nunca aparece "ready".
- `GET /api/falatu/bridge/records` + `/bridge/backfill-state` — consolidação por
  registro (linked_ok · divergente · quebrado · migrável · pessoal) e checkpoint;
  divergência **crescente** é critério de interrupção (§602).

## 4. Critérios de sucesso × interrupção

**Sucesso do ciclo** = os quatro trilhos comportam-se como o esperado da tabela
§2, as três superfícies refletem a atividade de forma coerente, e os números de
falha/latência ficam **dentro da baseline** definida (§600). SLA não é inventado
— é lido da baseline, não "garantido pelo fornecedor".

**Interromper e isolar a função afetada** (seguindo no resto — §602) diante de
qualquer item da coluna "Anomalia" acima ou dos critérios do runbook: acesso
entre empresas, exposição indevida ao CRM/atendente, repareamento inesperado,
duplicação de efeito financeiro, perda de tarefa/compromisso/arquivo, pico de
falha sem explicação, migração não reconciliada.

## 5. Depois da observação

- **Gate de ampliação (F7.3)** → rodar `GET /api/falatu/pilot-readiness`
  (owner/admin) ao fim da janela: veredito ADVISÓRIO dos gates OBJETIVOS de
  reconciliação (migração sem elo quebrado/divergência · fila sem preso/`unknown`
  não reconciliado · canais sem webhook rejeitado). `ready:false` lista os
  `blockers` a resolver ANTES de ampliar; `warnings` são atenção, não bloqueio.
  Limiares (`maxQueueAgeSec`/`maxUnknown`) vêm da baseline, não de SLA inventado.
- **Regressões observadas** → F7.3 (a IA corrige, quando autorizada e com acesso
  ao piloto; reconcilia migração/filas). Só ampliar com os gates cumpridos
  (o `pilot-readiness` acima verde).
- **Sem regressão crítica e piloto aprovado** → então, e só então, F7.4 (retirar
  duplicatas elegíveis: consumidores migrados, equivalência comprovada, dados
  reconciliados, rollback exercitado, sem escritor paralelo).

Até a observação real acontecer, o status honesto é **"ciclo provado localmente
em ensaio; validação do ciclo real em produção pendente"** (Gate G7).
