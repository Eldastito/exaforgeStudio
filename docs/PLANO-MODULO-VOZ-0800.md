# Plano — Módulo de Voz / Atendimento por Telefone (0800)

> Objetivo: conectar a IA à **telefonia que o cliente já tem** para (A) atender a
> ligação por voz na 1ª linha e (B) atuar como copiloto do atendente humano —
> reaproveitando o "cérebro" que já existe (orquestrador, RAG, CRM, handoff+resumo).
>
> Encaixa no gating da Fase 1 como o módulo opcional `voz`.

## 0. Contexto e premissas

- A telefonia/0800 é do **cliente**. Nós **conectamos** — não viramos operadora.
- A IA deve fazer **AMBOS**: atender sozinha a 1ª linha **e** virar copiloto ao
  passar para o humano.
- O **cérebro já está pronto**: `AIOrchestratorService`, RAG (`geminiRAG.searchContext`),
  CRM/perfil, `BusinessContextService`, Áreas/roteamento, handoff (`takeOverTicket`),
  resumo (`/api/ai/summarize`) e **transcrição de áudio (Whisper)** em `llm.ts`.
  Falta a **camada de voz em tempo real** + a **ponte com a telefonia**.

## 1. Decisão #0 — descobrir a telefonia (checklist pro cliente)

Como ainda não sabemos se é PBX próprio ou tronco, este checklist destrava o resto:
1. Existe **PBX/central**? Qual? (Asterisk, FreePBX, Issabel, 3CX, Vonage…)
2. O **0800/número** chega como **tronco SIP**? De qual operadora? Qual protocolo
   (SIP/IAX), codecs (G.711/alaw-ulaw, Opus) e há **IP fixo**/credenciais SIP?
3. Há firewall/NAT? Porta SIP/RTP liberáveis? Ambiente on-premise ou nuvem?
4. Volume: ligações simultâneas (concorrência) e minutos/mês esperados.

**Recomendação de conector universal:** colocar um **Asterisk** (que já existe no
cliente, ou um leve que subimos) como ponto de entrada. Tanto **PBX próprio**
quanto **tronco de operadora** terminam em SIP → o Asterisk entrega o áudio à
nossa ponte via **AudioSocket** ou **External Media (ARI)**. Assim o módulo fica
**agnóstico** ao que o cliente tem.

## 2. Arquitetura (componentes)

```
Telefonia do cliente (PBX/Tronco SIP/0800)
        │  SIP/RTP
        ▼
   [Asterisk]  ──AudioSocket/ARI (PCM)──►  [Ponte de Voz (WS)]  ◄──►  [Agente de Voz Realtime]
        ▲                                          │                       (OpenAI Realtime API,
        │  transferência (REFER)                   │  function calls         voz↔voz + tom/empatia)
        │                                          ▼
        │                                  [Ferramentas de Negócio] ──► OrdersService, PaymentService,
        │                                                                ReservationService, SubscriptionService,
        │                                                                geminiRAG, BusinessContextService, Áreas
        │                                          │
        └────────── handoff ◄──────────  [Painel ao vivo (Socket.IO)]  (transcrição + sugestões na tela)
```

- **Ponte de Voz** (novo serviço, WebSocket): recebe os frames de áudio do
  Asterisk, repassa ao agente de voz e devolve o áudio gerado. Controla início/fim,
  barge-in (cliente interrompe), silêncio, transferência.
- **Agente de Voz Realtime**: usa a **OpenAI Realtime API (speech-to-speech)** —
  conversa fluida, entende hesitações/gírias e capta o **tom** (empatia). Faz
  **function calling** para as ferramentas de negócio.
- **Ferramentas de Negócio**: wrappers sobre as services que já existem (mapa na §6).
- **Painel ao vivo**: emite pela `Socket.IO` (que já temos) a transcrição e as
  sugestões para a tela do atendente.

## 3. Por que Realtime (voz↔voz) e não STT→texto→TTS

- **Fluidez/latência**: o Realtime faz STT+raciocínio+TTS num único stream, com
  turnos naturais e barge-in — essencial pra "soar humano". STT→orquestrador→TTS
  empilha latência e trava a conversa.
- **Tom/empatia**: o modelo de voz percebe entonação (cliente irritado) e ajusta.
- **Reuso do cérebro**: as regras de negócio entram como **ferramentas (tools)**,
  então a lógica continua nas nossas services (fonte única de verdade), só que
  chamada por voz. (Para análise pós-call, ainda usamos o orquestrador em texto.)

## 4. Modo A — IA atende sozinha (1ª linha)

1. Ligação cai no Asterisk → Ponte de Voz → Agente Realtime atende.
2. IA cumprimenta, entende o pedido, consulta/age via ferramentas (ex.: "seu
   pagamento caiu, liberei… te mando o rastreio no WhatsApp" — usa as services).
3. Resolveu → encerra educadamente e registra a ligação no CRM (ticket/contato).
4. Precisa de humano → **transferência invisível** (§7).

## 5. Modo B — Copiloto do atendente

1. Humano atende (ou recebe a transferência). A Ponte de Voz mantém o stream e
   **transcreve ao vivo**.
2. Na tela do atendente (painel), em tempo real: **transcrição** + **sugestões de
   resposta** (reaproveita a lógica do "Sugerir Resposta") + dados do cliente (CRM).
3. Ao desligar: a IA **preenche o CRM** automaticamente — cria/atualiza o ticket,
   gera **resumo** (reusa `/api/ai/summarize`), move o kanban, registra a ligação.

## 6. Ferramentas expostas ao Agente de Voz (reuso direto)

| Ferramenta (voz) | Service existente | O que faz |
|---|---|---|
| `consultar_pedido` / status | `OrdersService` | status de pedido/pagamento do contato |
| `gerar_cobranca_pix` | `PaymentService` | gera PIX e envia no WhatsApp do cliente |
| `consultar_agenda` / `agendar` | `ReservationService` / agenda | disponibilidade, criar agendamento/reserva |
| `consultar_mensalidade` | `SubscriptionService` | situação da assinatura/fatura em aberto |
| `buscar_conhecimento` | `geminiRAG.searchContext` | responde dúvidas com a base (RAG) |
| `panorama_negocio` (gestor) | `BusinessContextService` | números do negócio (se for gestor) |
| `rotear_area` | `AttendanceAreaService` | direciona ao profissional/área certa |
| `transferir_humano` | handoff + Asterisk REFER | passa a ligação + resumo na tela |

## 7. Transferência invisível (sem repetir a história)

- A Ponte comanda o Asterisk a **transferir** a ligação (SIP REFER / ARI) para o
  ramal do atendente certo (definido pelas **Áreas**).
- Em paralelo, empurra para a tela do atendente o **resumo** do que o cliente já
  falou (reaproveita `/api/ai/summarize`) + histórico/CRM. Cliente não repete nada.

## 8. Modelo de dados

- Novo provider de canal `voice` na tabela `channels` (credenciais SIP/Asterisk).
- Nova tabela `voice_calls`: `id, organization_id, contact_id, ticket_id, direction
  (inbound/outbound), from_number, to_number, status, started_at, ended_at,
  duration, recording_url?, transcript?, summary?, handled_by (ai|human|transfer)`.
- Vínculo com `tickets`/`contacts` (a ligação vira/abre um ticket, como o WhatsApp).

## 9. Infra / Operação

- **Asterisk** alcançável (no cliente ou nosso) com AudioSocket/ARI habilitado;
  codecs G.711 (telefonia) ↔ PCM para a Realtime API.
- **Latência alvo** < ~700ms ida-e-volta para soar natural; região próxima.
- **Concorrência**: 1 sessão Realtime por ligação simultânea (dimensionar).
- **Custos**: minutos de telefonia são do **cliente**; nosso custo é o **áudio da
  Realtime API por minuto** (estimar por volume) + infra do Asterisk/ponte.

## 10. Segurança / LGPD

- **Consentimento de gravação** (aviso no início da ligação) e base legal.
- Retenção/expurgo de áudio e transcrição; mascarar PII sensível em logs.
- Autenticação SIP (sem trunk aberto), TLS/SRTP quando possível.
- Mesma trava de "gestor" para comandos administrativos por voz (não exposto a cliente).

## 11. Gating (Fase 1)

- Novo módulo opcional `voz` (rota→módulo + `OPTIONAL_MODULES` + preset onde fizer
  sentido). Aba "Telefonia/Voz" para configurar SIP/Asterisk e ver as ligações.

## 12. Ordem de entrega (incremental, testável)

1. **V1 — Prova de conceito (voz fala):** descoberta da telefonia + Asterisk +
   Ponte de Voz mínima ↔ Realtime API atendendo e **conversando com RAG** (responde
   dúvidas). Sem ferramentas de negócio ainda.
2. **V2 — Resolução autônoma + transferência:** ferramentas de negócio (pedido,
   PIX, agenda, mensalidade), **transferência invisível** com resumo na tela e
   registro da ligação (`voice_calls` + ticket).
3. **V3 — Copiloto + CRM:** transcrição ao vivo na tela do atendente, sugestões e
   **preenchimento automático do CRM** ao desligar; gravação/transcrição arquivada.

## 13. Pendências / decisões

1. **Descobrir a telefonia** (checklist §1) — bloqueia o conector exato.
2. Confirmar **provedor de voz** (recomendado: OpenAI Realtime API) e orçamento por minuto.
3. **Gravação de ligações**: liga/desliga + política de retenção (LGPD).
4. Onde roda o **Asterisk** (no cliente on-premise ou em nuvem nossa).
