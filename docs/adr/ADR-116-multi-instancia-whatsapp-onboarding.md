# ADR-116 — Onboarding liso de múltiplas instâncias de WhatsApp (Evolution)

**Status:** Planejado — executar **pós go-live TOULON**. Não altera o caminho ao
vivo do WhatsApp antes da estreia (decisão do produto; ver ADR-110, achado #5).
**Origem:** Emerson — _"cada loja/número com seu canal e sua conta"_; dúvida
operacional após erro de webhook (segredo) e pergunta "quantas instâncias o
ZappFlow suporta?".

## Contexto — o que EXISTE hoje (levantamento no código)

O runtime de mensagens **já é multi-instância**, mas o **onboarding** e alguns
pontos globais assumem uma instância só:

**Já funciona (multi):**
- **Entrada:** o webhook usa `payload.instance` como `businessId` e roteia por
  `identifier` → linha em `channels` → `organization_id` (`server.ts`,
  `dispatchIncomingMessage({ identifier: businessId })`). Cada instância cai no
  seu canal/conta.
- **Saída:** `MessageProviderService.sendMessage(channelId, …)` resolve
  `instanceName = channel.identifier` e `baseUrl = metadata.baseUrl || env`. É
  por canal.

**Ainda global / single-instance (as arestas):**
1. `evolutionConfig` é **um objeto global** (baseUrl/apiKey/instanceName), usado
   pelo pareamento (`/api/evolution/config`, `/api/evolution/instance/connect`),
   pelo download de mídia/áudio e pela busca de avatar.
2. `connection.update` auto-registra o canal com `orgId = 'default_org'`
   **hardcoded** (`server.ts` ~879) — nova instância não sabe de quem é.
3. Na saída, `token = process.env.EVOLUTION_API_KEY || channel.token_encrypted`
   — a **env tem prioridade**, então todos os canais compartilham a mesma apikey
   se a env estiver setada (instâncias no MESMO servidor Evolution funcionam;
   servidores/tokens distintos por canal, não).
4. **Segredo do webhook é global** (`effectiveWebhookSecret()`) e o diagnóstico
   `webhook_last` também é **global** — uma instância mal configurada deixa o
   cartão vermelho para todas.
5. Rate-limit de webhook é **por IP** (120/min) — instâncias saindo do mesmo IP
   da Evolution somam no mesmo balde.

> **Conclusão:** não há teto de "uma conexão" nem "quebra" com várias. O teto
> real é a capacidade do servidor Evolution. O que falta é **onboarding** e
> **diagnóstico por instância**.

## Decisão (desenho a executar pós go-live)

Tornar o **canal** (`channels`) a fonte única da configuração de cada número,
escopado por `organization_id`, e aposentar o estado global no fluxo de setup.

### Bloco 1 — Canal como fonte da verdade (baixo risco)
- Cada número = uma linha em `channels` (`organization_id`, `provider='evolution'`,
  `identifier=instanceName`, `metadata_json={ baseUrl, token }`, `status`).
- Saída: preferir `channel.token_encrypted` quando presente; **env vira fallback**
  (não prioridade). Instância no mesmo servidor segue funcionando; passa a
  suportar servidores/tokens distintos por canal.

### Bloco 2 — Pareamento por instância (o coração do onboarding)
- `/api/evolution/instance/connect` recebe `channelId` (ou cria um canal novo)
  e resolve baseUrl/token/instanceName **do canal**, não do `evolutionConfig`
  global. O canal nasce com o `organization_id` **do req.user** (RBAC), nunca
  `default_org`.
- `connection.update`: resolve a org pelo canal cujo `identifier == payload.instance`;
  se não existir, cria **pendente** vinculado à org que iniciou o pareamento —
  remove o `default_org` hardcoded.

### Bloco 3 — Diagnóstico e mídia por instância
- `recordWebhookHit`/`getLastWebhookHit` passam a ser **por canal** (chave
  `webhook_last:<channelId>`), e a tela mostra o status **de cada número**.
- Download de mídia/áudio e avatar resolvem baseUrl/token do canal do
  `payload.instance` (já preferem `payload.instance`; falta trocar o
  `cfg` global pelo do canal).
- Segredo do webhook: manter **um** segredo global (simples e suficiente) —
  documentar que o mesmo segredo vale para todas as instâncias. (Opção futura:
  segredo por canal na query, se algum cliente exigir isolamento.)

### Bloco 4 — UI (ChannelsPanel)
- Lista de números de WhatsApp da org, cada um com: QR/conectar próprio,
  status de conexão, **saúde do webhook por número**, botão "Adicionar número".
- Onboarding: "Adicionar número" → cria canal na org → parear por QR → verde.

## Compatibilidade / não quebrar

- A instância única de hoje (TOULON) vira **um canal default** na migração;
  nenhum fluxo muda para ela.
- Trocar a prioridade token (env→fallback) é o ponto mais sensível: cobrir com
  teste antes (envio single-instance com env setada continua idêntico).

## Plano de teste (antes de mexer no fluxo vivo)

- Regressão: `test:instagram-send` e envio Evolution single-instance (env
  setada) inalterados.
- Novo `test:multi-instance-routing`: 2 canais/2 orgs; entrada por
  `payload.instance` cai na org certa; saída usa o `instanceName` do canal;
  `webhook_last` isolado por canal.
- Rota de pareamento cria canal na org do `req.user`, nunca `default_org`.

## Consequências

- Cadastro de vários números vira self-service, cada loja/número na sua conta.
- Diagnóstico de webhook deixa de ser global (um número quebrado não "apaga" os
  outros no painel).
- Fecha o achado #5 do ADR-110 sem risco ao piloto (executado depois da estreia).

## Fora de escopo

- Billing/limite comercial de nº de instâncias por plano (decisão à parte;
  hoje o teto é o servidor Evolution, não o app).
