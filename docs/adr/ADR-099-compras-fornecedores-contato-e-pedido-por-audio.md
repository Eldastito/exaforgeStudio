# ADR-099 — Compras/Fornecedores: perfil com contato, cotação por e-mail e pedido de compra por áudio

**Status:** Bloco imediato implementado (jul/26). Bloco futuro de rede (compra coletiva + retroalimentação) aprovado, aguardando rede madura.

**Origem:** Item #11 do `docs/BACKLOG-CAMPO-TOULON.md`. Três frentes: (a) a aba "Ser fornecedor" não tem campos de contato, botão salvar nem clareza de "novo registro"; (b) automatizar o contato com fornecedores (e-mail + WhatsApp), com "compra coletiva" e "retroalimentação"; (c) falta uma aba de "pedido de compra" onde o gestor grava a lista por **áudio** no Zap e a IA salva.

---

## Contexto (o que existe hoje)

O domínio Supply/Compras tem 3 fases já implementadas: **Fase 1** reposição inteligente (intra-org), **Fase 2** cotação a fornecedores conhecidos (WhatsApp), **Fase 3** rede ZappFlow (perfil de fornecedor cross-org).

**Dois conceitos distintos de "fornecedor" (não confundir):**
- **Perfil de rede** (a org se oferece como fornecedora — Fase 3): `SupplyNetworkService.ts`, colunas em `organization_settings` (`is_network_supplier`, `network_categories`, `address_city/state/lat/lng`, `network_delivery_radius_km`, `network_min_order_amount`). **`saveProfile` NÃO grava contato** (telefone é só-leitura das configs; sem e-mail/WhatsApp). Auto-save via `onBlur`, sem botão nem feedback.
- **Fornecedor local** (contato do CRM marcado — Fase 2): `contacts.is_supplier=1` + `supplier_categories`. Contato = `identifier` (WhatsApp) + `email`. Cadastrado em **Contatos**, não na aba "Ser fornecedor".

**Cotação automática (já existe):** ao aprovar uma reposição (`procurement.ts` approve → `SupplierQuoteService.sendQuotes`), dispara mensagem **por WhatsApp** aos fornecedores locais e pré-cria cotações pros da rede preencherem na UI. Respostas parseadas por IA (`parseSupplierReply`, LLM `json:true`). **Sem canal de e-mail.**

**Reposição/pedido de compra:** hoje é **100% automático** — `PurchaseRequisitionService.syncDraft` cria um `draft` (`created_by='ai'`) a partir de itens abaixo do `low_stock_threshold`. **Não há endpoint de criar pedido manual**, nem fluxo por áudio. Status: `draft | approved | dismissed | ordered`.

**Áudio do WhatsApp (base pronta pra reusar):** transcrição já ligada — `transcribeAudio` (`llm.ts`, Whisper, PT). O gestor autorizado já é identificado e roteado (`AIOrchestratorService.processMessage` + `findAuthorizedManager`); há máquina de estado conversacional (`PendingManagerActions`) e padrão de extração estruturada por IA. Um áudio de gestor já vira texto ANTES do orquestrador — indistinto de mensagem digitada. Falta só o **intent novo** de "pedido de compra".

## Decisão

### 1. Aba "Ser fornecedor" — contato + salvar + clareza (bloco imediato)
- **Campos de contato** no perfil de rede: **WhatsApp** e **e-mail** graváveis (novas colunas: `network_contact_whatsapp`, `network_contact_email`), pra quem te acha na rede conseguir te chamar.
- **Botão "Salvar" explícito** com feedback ("Salvo ✓"). Mantém o auto-save como conveniência, mas o botão + confirmação matam a dúvida "será que salvou?".
- **Texto de clareza:** deixar explícito que essa aba é **o seu perfil pra aparecer na rede** (registro único), com um **atalho pra Contatos** pra cadastrar os fornecedores de quem você compra. Resolve o "como limpa pra novo registro?" (era mismatch de modelo mental, não bug).
- Validação leve dos campos de contato (formato de e-mail, WhatsApp com DDI/DDD).

### 2. Cotação automática por e-mail (bloco imediato) + compra coletiva/retroalimentação (bloco futuro)
- **E-mail como canal paralelo ao WhatsApp:** quando o fornecedor tiver e-mail, a cotação automática também sai por e-mail (reusa `GoogleOAuthService.gmailSend`, já usado em cobrança). WhatsApp continua sendo o canal primário; e-mail é adicional, não substituto.
- **Compra coletiva + retroalimentação — APROVADAS como direção, em bloco próprio depois.** São features grandes de rede (agregar a demanda de várias lojas pra ganhar poder de barganha; e um loop de feedback fornecedor↔lojista). Precisam de rede madura (várias orgs ativas como fornecedoras/compradoras) — não fazem sentido no piloto com 1 loja. Ficam documentadas aqui como roadmap, com escopo próprio quando a rede tiver massa.

### 3. Pedido de compra por áudio + criar manual (bloco imediato)
- **Novo intent de gestor:** o gestor manda áudio no Zap ("compra 20 camisas polo brancas") → `transcribeAudio` (já existe) → IA extrai itens estruturados (produto, quantidade, obs) reusando o padrão `parseSupplierReply`/`parseInventoryReply` → cria/edita um **pedido de compra manual** (`created_by='manager'`, status `draft`) → confirma com o gestor antes de aprovar.
- **Destrava o "criar pedido manual"** que hoje não existe: um endpoint/rota pra criar/editar requisição fora do fluxo automático de estoque baixo. O áudio é uma das entradas; a UI também ganha "criar pedido" manual.
- Reusa `PendingManagerActions` pra confirmação multi-turno ("confirma esses 3 itens?" → "sim").

## Consequências

**Positivas:**
- Perfil de fornecedor fica utilizável (contato + salvar claro) — a rede deixa de ter fornecedores "sem telefone".
- E-mail amplia o alcance da cotação (fornecedor que não usa WhatsApp comercial).
- Pedido por áudio é ergonomia real de campo: o dono no corredor da loja fala e a IA registra — sem parar pra digitar.
- Criar pedido manual preenche um buraco (hoje só dava pra esperar o automático detectar estoque baixo).

**Trade-offs aceitos:**
- Campos de contato no perfil de rede = nova migração + validação; pequeno.
- E-mail depende de Google conectado (como a cobrança) — se não tiver, cai só no WhatsApp (degradação graciosa).
- Extração de itens por áudio pode errar (nome ambíguo, quantidade dúbia) — por isso **confirmação obrigatória** antes de virar pedido; nunca cria direto.
- Compra coletiva/retroalimentação adiadas — aceito: sem rede madura não há o que agregar. Direção aprovada, execução faseada.

## Implementação

**Bloco imediato (#11 core) — ✅ implementado (jul/26):**
1. Schema: `network_contact_whatsapp`, `network_contact_email` em `organization_settings`; `source` ('auto'|'manual') em `purchase_requisition_items`.
2. `SupplyNetworkService.saveProfile`/`profile`: contato persistido + validação (WhatsApp com DDI, e-mail). (PR A)
3. `ProcurementView` aba "Ser fornecedor": campos de contato + botão Salvar com "Salvo ✓" + texto/atalho pra Contatos. (PR A)
4. `SupplierQuoteService.sendQuotes`: canal e-mail paralelo via `gmailSend` (quando houver e-mail + Google conectado), degradação graciosa; retorno ganha `emailed`. (PR B)
5. Pedido por áudio/texto: o áudio já vira texto no `server.ts` (transcrição Whisper existente). `AIOrchestratorService` ganha um gatilho de intenção de compra (por palavra-chave, sem sequestrar conversa) → `PurchaseRequisitionService.extractOrderFromText` (LLM) → `matchItemsToProducts` (casa com o catálogo) → `savePendingAction('purchase_order_audio')` → confirma SIM/NÃO → `addManualItems`. (PR C)
6. "Criar pedido manual": `addManualItems` mescla os itens ditados no rascunho corrente marcados `source='manual'`; `syncDraft` foi ajustado para **preservar** as linhas manuais (só recalcula as 'auto'). Assim o pedido do gestor aparece e é aprovável na tela de Compras existente, sem UI nova. (PR C)
7. Testes: `test:supplier-profile-contact` (12/12), `test:quote-email-channel` (10/10), `test:purchase-order-by-audio` (16/16). Todos no CI.

> Escopo do bloco imediato: e-mail é **só de saída** (respostas seguem por WhatsApp/UI; inbound de e-mail = bloco futuro). O gatilho do pedido por voz é por palavra-chave + confirmação obrigatória (nunca cria sem SIM). Itens ditados fora do catálogo são reportados para cadastro, não inventados.

**Bloco futuro (rede madura):**
8. Compra coletiva: agregação de demanda entre orgs da rede + negociação em volume.
9. Retroalimentação: loop de feedback fornecedor↔lojista (avaliação, histórico de cumprimento, ranking).

## Aprovação

Aprovado por Emerson (jul/26): (1) campos de contato + botão salvar + clareza na aba "Ser fornecedor"; (2) e-mail como canal paralelo na cotação automática, e compra coletiva + retroalimentação **aprovadas como direção, em bloco próprio depois** (rede madura); (3) pedido de compra por áudio + criar pedido manual. Item #11 do backlog marcado `[x] decidido`.
