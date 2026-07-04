# ADR-037 — Fashion AI Studio, FAS-3: orquestrador de try-on ("look em você")

**Status:** Implementado e testado (20 verificações novas, suíte completa sem quebras — 36 scripts, `lint`/`build` limpos). A **qualidade visual** da geração só se valida em produção com foto/peças reais — ver "O provedor é uma hipótese", abaixo.
**Origem:** PRD-E-006, quarta entrega (FAS-3). Nenhuma migration nova.

## O que o FAS-3 entrega

O botão "Ver em mim": a cliente com foto aprovada gera a prévia do look na própria foto — job assíncrono, créditos do limite diário, resultado privado com URL assinada, cancelamento e purga por retenção.

### 1. Provedor plugável (seção 9.2 / ADR candidata A do PRD)

A geração fica atrás da interface `TryOnProvider` (`available()` + `generate()`), selecionada por env `FASHION_TRYON_PROVIDER`. O provedor padrão (`openai_edit`) usa a **edição multi-imagem** da OpenAI (`gpt-image-1`): foto da cliente + fotos reais das peças (a foto de estúdio da ADR-032 tem prioridade — é a versão mais limpa) numa única chamada. Mesmo princípio das ADRs 032: **edição preserva o real** (pessoa e peças verdadeiras); geração do zero inventaria uma pessoa/peça genérica.

**O provedor é uma hipótese, não uma decisão fechada**: o PRD (ADR candidata A) manda decidir só após teste real de qualidade/custo/privacidade. A arquitetura entrega exatamente isso — validar com foto e peças da TOULON; se a qualidade do `openai_edit` não bastar, plugar um serviço dedicado de virtual try-on é registrar outra implementação da interface, sem tocar no orquestrador, nos créditos ou na UI.

### 2. Créditos (seção 9.3) — regras do PRD à risca

- Janela **diária** por cliente com o limite da loja (FAS-0: `fashion_daily_generation_limit`, padrão 3, clamp 1–20).
- **Reserva** no aceite do job → **consome só no sucesso** → **falha técnica devolve automaticamente**. Resultado ruim NÃO devolve (política explícita do PRD; ajustável por loja no futuro).
- **Idempotência que economiza**: `input_hash` (avatar + itens + provedor). Mesmo pedido já `SUCCEEDED` → devolve o resultado pronto **sem gastar crédito nem IA**; mesmo pedido ainda na fila → devolve o job existente. Mesmo princípio "consultar antes de gastar" da foto de estúdio (ADR-032).

### 3. Fila e estados (seções 9.4/RNF-005)

Reaproveita o `JobQueueService` existente (handler `fashion_tryon`) com **`maxAttempts=1`**: repetir uma geração cara é decisão da **cliente** (botão "Gerar de novo"), nunca retry automático silencioso — mesmo racional da ADR-029 (webhook). Estados do PRD (`QUEUED → PROCESSING → SUCCEEDED/FAILED_FINAL`, `DELETED` no cancelamento, `EXPIRED` na purga) na tabela `fashion_tryon_jobs` (nascida no FAS-0), com `error_message_safe` (nunca detalhes internos) e `error_code` para telemetria.

### 4. Segurança do prompt (seção 19.2)

O prompt do provedor é **fixo no código** — nunca composto com texto do catálogo ou da cliente (anti-injection): preservar rosto/identidade/tom de pele/idade aparente, sem pessoas extras, sem nudez/sexualização, peças fiéis às fotos originais, fundo neutro.

### 5. Resultado privado, cancelamento e retenção

- Saída no mesmo diretório privado do avatar (FAS-1), lida só por **URL assinada com expiração** — nunca `/media` público; nunca vira foto de produto (regra 9.3).
- Cancelamento (RF-024): só enquanto `QUEUED` (processamento não é interrompível), com estorno do crédito.
- Purga no `Scheduler`: resultado além da retenção da loja (mesma janela do avatar) tem o **arquivo apagado** e vira `EXPIRED`.

### 6. UI

Cada card de look ganha "Ver em mim" (com estado de progresso e polling), a imagem final aparece no próprio card, e o contador "X de Y prévias restantes hoje" fica visível. Limite esgotado/erros chegam como mensagens amigáveis do servidor.

## Fora desta fase

- FAS-4: carrinho do look completo transacional + link seguro via WhatsApp.
- FAS-5: memória de estilo (sinais observados).

## Validação

`npm run test:fashion-tryon` (20 verificações) + suíte completa (36 scripts, zero quebras) + `lint`/`build` limpos. Destaques: ciclo completo do crédito (reserva/consumo/estorno/limite); idempotência nos dois estados (em andamento e pronto); ownership de job/look entre clientes e organizações; cancelamento só na fila com estorno; purga apaga o arquivo físico; URL do resultado é sempre assinada; sem chave de IA o job falha `FAILED_FINAL` com crédito devolvido e mensagem segura.
