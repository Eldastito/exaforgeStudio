# Runbook — Piloto WhatsApp Unificado / Fala Tu (F7.1)

> **F7.1 (RF §21 / Gate G7).** Runbook de **ativação por flag + rollback**
> exercitável, para o piloto TOULON. **Doc-only.** Não liga nada em produção:
> a ativação real (números de teste, flags de produção, janela de observação) é
> **decisão do dono** e não é feita pela IA.
>
> **Estado honesto (Gate G7):** todo o código das Fases 0–6 + X1 + F1.2d está
> **implementado e testado localmente** (CI verde, CA-01..CA-10 provados por
> teste). O piloto em produção é **validação pendente** — nunca declarar "pronto
> em produção" sem o ciclo real observado e aprovado.

## 0. Princípios do rollout (RF §21)

- **Ordem (§598):** staging com fixtures → dados de migração representativos →
  **número de teste autorizado** → **empresa piloto** → ampliação gradual.
- **Reversível por flag:** o caminho novo é sempre opt-in; rollback = **desligar
  o roteamento novo**, mantendo as migrações **aditivas** e os mapeamentos.
- **Nunca** restaurar banco antigo cegamente sobre dados novos; **tokens/sessões
  não voltam por troca de código** (mudança remota na Evolution é preservada).
- **Uma flag por vez**, cada uma verificada antes da próxima.

## 1. Pré-requisitos de ambiente (antes de qualquer flag)

| Env | Papel | Ação |
|---|---|---|
| `APP_URL` | URL absoluta p/ links assinados de arquivo (F5.3) e Radar | Definir com o domínio público real; sem ela, entrega de arquivo cai pro fallback honesto (`no_public_base`). |
| `ENCRYPTION_KEY` | Cifra dos segredos em repouso (X1) | **Definir uma chave DEDICADA** (hoje deriva do `JWT_SECRET` com aviso). Trocar `JWT_SECRET` depois do backfill quebraria a leitura dos tokens cifrados. |
| `WEBHOOK_QUEUE_ENABLED` | Fila durável de inbound | Já default-ON em produção; confirmar. |

> Ao subir com `ENCRYPTION_KEY` definida, o boot roda `backfillExistingSecrets` e
> cifra os tokens de canal existentes. **Verificar:** nenhum `channels.token_encrypted`
> em texto puro (todos com prefixo `enc:v1:`).

## 2. Baseline a registrar ANTES de ligar (§600)

Congelar, para a org piloto: baseline de **falhas** de envio, **volume** diário,
**tempo de resposta**, **configuração de canal**, **flags** atuais, **filas**
(`background_jobs`, `message_deliveries`) e **contagens** de dados (contatos,
tarefas, tickets). Fontes prontas:
- `GET /api/falatu/whatsapp-health` — saúde por canal (etapa + contadores + idade de fila) + métricas mínimas.
- `GET /api/channels/states` — estados lógicos (sessão/webhook/administração/operação).
- `GET /api/falatu/bridge/records` e `/bridge/backfill-state` — inventário/estado da consolidação.

Definir a **janela de observação** cobrindo as automações diárias (lembretes,
cadências, digests) e critérios objetivos de latência/capacidade **a partir
dessa baseline** — não inventar SLA como se fosse garantido pela Evolution.

## 3. Ordem de ativação (uma por vez, verificando cada)

| # | Liga | Como | Verificar (sucesso) |
|---|---|---|---|
| 3.1 | **Segurança de webhook (A10)** | Colar na Evolution a URL com `?secret=<segredo>` (Integrações mostra o segredo) → ligar enforce (`setWebhookEnforced(true)` / toggle na tela) | `GET /api/channels/states` → `webhook: healthy` após o 1º evento; `/whatsapp-health` sem `rejected`. Se `rejected` → a URL não está com o segredo certo: **reverter enforce** e corrigir a URL. |
| 3.2 | **Finalidade por canal (F2.4)** | Criar `channel_feature_bindings` **espelhando o uso atual** (ex.: `atendimento` + `gestao` habilitados no canal) via `POST /api/channels/bindings` | `GET /api/channels/states` → `operation: ready`; um envio real de cada finalidade habilitada sai; finalidade **não** configurada segue passando (0-regressão). |
| 3.3 | **Consolidação de registros (F4)** | Na org piloto, ligar `falatu_bridge_tasks_enabled` / `_lists_enabled` (events = não-aplicável) → `POST /bridge/backfill-tasks` com `dryRun:true`, conferir, depois real | `/bridge/records` sem `broken_link` inesperado; `/bridge/backfill-state` com `ready`; conclusão converge (CA-09). |
| 3.4 | **Modo misto (F3.3b)** | Ligar `organization_settings.mixed_mode_enabled = 1` na org piloto (com telefone de gestor **verificado**, F3.2) | Mensagem do gestor pelo número comercial → roteia p/ gestão (não vira lead); cliente → atendimento; dúvida de papel → pergunta "atendimento ou gestão?". |
| 3.5 | **Entrega durável (opcional)** | `CONTINUITY_DELIVERY_QUEUE_ENABLED=on` + `PDF_REPORT_ASYNC_ENABLED=on` | `/whatsapp-health` mostra fila drenando; taxonomia de falha (permanent/transient/unknown) coerente. |

**Modo comparação (§598):** enquanto observa, o caminho novo pode ficar em
shadow — não enviar mensagem nem executar ação — antes de habilitar o envio real
por canal. (Onde aplicável às flags acima.)

## 4. Rollback por flag (§604)

Rollback é **desligar o roteamento novo**, na ordem inversa. As tabelas/colunas
aditivas **permanecem** (não destrutivo):

| Reverter | Como | Efeito |
|---|---|---|
| Modo misto | `mixed_mode_enabled = 0` | Inbound volta 100% a atendimento (fail-open já é o default). |
| Finalidade | Desabilitar/remover os `channel_feature_bindings` | Sem binding → comportamento herdado (envio passa). |
| Consolidação | `falatu_bridge_*_enabled = 0` | Silo do Fala Tu segue legível; vínculos preservados; nada apagado. |
| Webhook enforce | `setWebhookEnforced(false)` | Volta a aceitar sem segredo (só se a URL da Evolution ainda não tem `?secret=`). |
| Entrega durável | `CONTINUITY_DELIVERY_QUEUE_ENABLED=off` | `/send` volta ao caminho inline. |

**Nunca:** restaurar banco antigo sobre dados novos; reverter para código com
resolução de tenant incorreta (nesse caso, **manter recebimento durável e PAUSAR
o processamento** afetado até corrigir — histórico, IDs de efeito, política e
filas sobrevivem ao rollback). Restaurar backup é ação de recuperação SEPARADA,
com reconciliação dos eventos após o backup. Segredos/sessão da Evolution: mudança
remota é preservada (não some por troca de código); documentar o que mudou.

## 5. Critérios de INTERRUPÇÃO da ampliação (§602)

Parar de ampliar e **isolar a função afetada** (seguindo o trabalho no resto) se
aparecer qualquer um:
- acesso **entre empresas** (cross-tenant);
- exposição de dado **interno** ao CRM público / a atendente sem permissão;
- exclusão/repareamento **inesperado** de sessão/instância;
- **duplicação de efeito financeiro** (cobrança/pagamento);
- **perda** de tarefa/compromisso/arquivo;
- aumento de **falha sem explicação**;
- **migração não reconciliada** (`/bridge/records` com divergência crescente).

## 6. Superfícies de observação já prontas (desta jornada)

- `GET /api/falatu/whatsapp-health` — canal × etapa da falha + recuperação + métricas (§18.6), token-safe (F6.4).
- `GET /api/channels/states` — 4 dimensões lógicas RF-02 (F1.2d).
- `GET /api/falatu/bridge/records` · `/bridge/backfill-state` — consolidação (F4).
- `GET /api/falatu/reports/summary` + entrega de arquivo (F5); catálogo em `FileRequestCatalogService`.

## 7. Fechamento do Gate G7 (o que falta, e de quem é)

- **Do dono/operador:** selecionar org+números de teste autorizados; registrar a
  baseline; ligar as flags na ordem acima; observar a janela definida; aprovar
  conforme o processo do projeto; exercitar 1 rollback real.
- **Da IA (quando autorizado e com acesso ao piloto):** corrigir regressões
  observadas (F7.3), reconciliar migração/filas, e só então F7.4 (retirar
  duplicatas elegíveis — **somente** com consumidores migrados, equivalência
  comprovada, dados reconciliados, rollback exercitado e sem escritor paralelo).

Até lá, o status honesto é **"implementado/testado localmente; validação em
produção pendente"**.
