# ADR-177 — FIN: Conexão de Cobrança Sicredi (scaffold honesto)

- **Status:** Implementado (1 fatia — scaffold). Emissão real PENDENTE de
  homologação bancária (terceiro).
- **Data:** 2026-08-16
- **Origem:** PRD "ZapFlow Moda/TOULON — Melhorias v1.0", frente FIN/Sicredi.
- **Relacionadas:** ADR-083 R1 (`RetailCardAcquirerService` — stub Sicredi
  Adquirência), ADR-167 F2 (`SocialConnectionService` — hub de conexão),
  ADR-054 (`EncryptionService`), ADR-164 (padrão de scaffold configurável e
  honesto: `VpsSpecProfileService`/`SloDefinitionService`).

## Contexto

A frente FIN do PRD pede a Sicredi como banco de **cobrança** (emitir PIX/boleto
para os recebíveis). Diferente do lado ADQUIRÊNCIA (cartão, já stubado em
`RetailCardAcquirerService`), a Cobrança/PIX tem API pública no portal do dev da
Sicredi — mas exige **credenciais + homologação bancária** (mTLS/cert +
`client_id`/`secret` por cooperativa) que **dependem do banco**. O ASAAS segue
mockado por decisão do operador.

Não dá para emitir cobrança real hoje. Mas dá para entregar a **fundação
honesta**: o hub de conexão (config + estado), disponível para configurar e
pronto para receber a chamada real quando a homologação fechar — sem inventar
comportamento nem fingir que emite.

## Decisão

Um **scaffold honesto** de conexão de Cobrança Sicredi, opt-in e reversível,
espelhando o stub honesto do `RetailCardAcquirerService.syncFromSicrediApi` e o
hub de conexão do `SocialConnectionService`.

1. **Tabela** `sicredi_cobranca_connections` (1 por org, opt-in): `config_enc`
   (JSON de credenciais CIFRADO — AES-GCM/`EncryptionService`), `connection_state`
   (`not_configured` | `awaiting_homologation` | `connected` | `disabled`),
   `enabled`, timestamps.
2. **`SicrediCobrancaService`**:
   - `status(orgId)` — REDIGIDO: nunca vaza segredo (só `hasCredentials` +
     campos públicos: cooperativa/posto/conta/beneficiário/ambiente); as 4
     capacidades (`issue_pix`/`issue_boleto`/`query_charge`/`webhook_settlement`)
     ficam **indisponíveis** enquanto não homologado.
   - `configure(orgId, patch, {enabled})` — grava credencial cifrada (merge);
     estado vira `awaiting_homologation` (com credencial + ligado), `disabled`
     (com credencial, desligado) ou `not_configured` (sem credencial). **NUNCA**
     marca `connected` — configurar não homologa (RN-177-002).
   - `disconnect(orgId)` — limpa (reversível).
   - `issueCharge(orgId, …)` — **STUB HONESTO**: lança
     `sicredi_awaiting_homologation` (ou `sicredi_not_configured`). É o ponto de
     plugue da chamada real (OAuth2 mTLS + endpoint Cobrança/PIX) quando as
     credenciais chegarem; **não emite dinheiro** (RN-177-004).
3. **Rotas** `/api/fin/sicredi/cobranca/{status,config,disconnect,charge}`
   (owner/admin). `charge` devolve **501 + `awaitingHomologation:true`** — o
   caminho da UI é verdadeiro (nunca finge emissão).

## Regras de Negócio

- **RN-177-001 (tenant):** `orgId` 1º arg; `UNIQUE(org)` → 1 conexão por org.
- **RN-177-002 (nunca finge conectado):** sem homologação real, o estado nunca é
  `connected`; capacidades indisponíveis.
- **RN-177-003 (segredo cifrado/redigido):** credenciais só cifradas; `status`
  nunca devolve segredo.
- **RN-177-004 (não emite dinheiro):** `issueCharge` lança — não emite PIX/boleto.
- **RN-177-005 (opt-in/reversível):** default desligado; `disconnect` limpa.

## Consequências

- A org pode CONFIGURAR a Sicredi e ver um estado honesto ("aguardando
  homologação"); quando o banco liberar, só o miolo de `issueCharge` (+ um probe
  real de homologação que promova a `connected`) precisa ser implementado.
- Aditivo/retrocompatível; isolado por organização; sem motor/gateway paralelo.

## Fora desta fatia (pendente de terceiro)

- **Emissão real** de PIX/boleto (OAuth2 mTLS + endpoint Cobrança/PIX) — depende
  das credenciais + homologação Sicredi.
- **Probe de homologação** que promova `awaiting_homologation → connected`.
- **Webhook de liquidação** (settlement) casando cobrança → recebível.
- UI de configuração em Configurações › Financeiro (o backend já responde).

Teste: `scripts/test-sicredi-cobranca.ts` (16 checks).
