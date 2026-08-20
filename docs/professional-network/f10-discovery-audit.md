# ADR-180 F10 — Auditoria da descoberta cross-org (rede/marketplace)

Doc-only (F10.0). Síntese da auditoria read-only do codebase que fundamenta a fronteira de
privacidade travada na seção F10 do ADR-180. Formato: capacidade → o que existe (arquivo:linha)
→ reusar/estender/novo → nota de fronteira.

## Tese central

A descoberta cross-org é **identidade-atribuída de propósito** — o valor É revelar QUEM (qual
clínica precisa da especialidade / qual especialista está disponível). Logo o precedente certo
é o **`SupplyNetworkService`** (marketplace de fornecedores cross-org, opt-in, tier
público×privado), **não** o `vertical_intelligence` (camada anonimizada org-free). O gate
`assertNoTenantData` do mundo anonimizado REJEITARIA justamente as identidades que a descoberta
precisa expor. A privacidade em F10 protege **paciente, financeiro e o grafo de vínculos** —
nunca as identidades públicas.

## Capacidades

| Capacidade | Existe (arquivo:linha) | Verdito | Nota de fronteira |
| --- | --- | --- | --- |
| Marketplace cross-org opt-in (PRECEDENTE) | `SupplyNetworkService.ts` (arquivo) · flag `organization_settings.is_network_supplier` (`db.ts:1463`) · `listSuppliers(buyerOrg, opts)` (`:139-180`) | **Molde a espelhar** | tier público (nome/categoria/cidade) × privado (preço/estoque só após cotação); exclui self; raio decidido pelo ofertante |
| Geo (cidade→coord, distância) | `SupplyNetworkService.geocodeCity` (`:30-55`) + `distanceKm` Haversine (`:12-23`) + `geocode_cache` | **Reusar** | match por região grossa (cidade/estado/raio), nunca endereço exato |
| Identidade global do profissional | `professionals` (`db.ts:10122-10138`, sem `organization_id`, `UNIQUE(council,registration)`) · `ProfessionalService.map/search/upsertIdentity` | **Estender** | SEM flag de visibilidade e SEM localização hoje — lacuna do F10.1 |
| Especialidades (fonte autoritativa) | GLOBAL `professionals.specialties_json` (`db.ts:10128`) × per-org `clinic_professional_specialties` (`db.ts:2761-2775`) | **Usar a global** | `specialties_json` é a ÚNICA fonte org-free; a per-org revela em que clínica o prof atende → NÃO pode semear o diretório |
| Camada shared org-free (filosofia de guarda) | `vertical_intelligence` (`db.ts:8172-8193`, sem org) + `researchAnonymize.assertNoTenantData/sanitizeForShared` | **Só a filosofia** | chokepoint de sanitização aplicado a paciente/financeiro; NÃO ao esconder identidade (seria contraproducente) |
| Sinal de demanda como input | `ProfessionalDemandService.publishGaps` → `professional_network/demand_gap` (evidence `serviceName/unmet/declined/met`, sem paciente) | **Reusar (projeção)** | publica só `especialidade + bucket de pressão + região`; NUNCA contagem crua nem `met` (revela receita) |
| Localização da clínica | `organization_settings.address_city/address_state/address_lat/address_lng` (`db.ts:1465-1468`) + `network_delivery_radius_km` (`:1469`) | **Reusar** | cidade/estado/raio bastam; sem rua exata |
| Localização do profissional | **NÃO existe** em `professionals` | **Novo (F10.1)** | add `base_city/base_state/base_lat/base_lng` |
| Opt-in de descoberta | `professional_network_enabled` (`db.ts:10167`) + `autobooking_enabled` (`:10254`) são flags de CONSUMO da clínica | **Novo (dos 2 lados)** | add `professionals.discoverable` + `organization_settings.network_discoverable`, ambos default 0 |
| Entrada do funil (convite) | `ClinicProfessionalRelationshipService.invite(orgId, {professionalId\|identity}, actor)` (`ClinicProfessionalRelationshipService.ts:122-159`) | **Reusar** | descoberta entrega `professionalId` → `invite` → `pending` → aceite existente; sem bypass do consentimento |
| Diretório interno (tom de guardrail) | `RetailSellerDirectoryService.discoverByStore` (`:99-123`) — diagnóstico, "nunca auto-confirma pessoa" | **Precedente de tom** | descoberta SUGERE, nunca auto-vincula |

## O que a projeção publicável carrega × nunca carrega

**Profissional (opt-in):** nome · conselho+registro · especialidades (`specialties_json`) ·
região base (cidade/estado) · contato-ao-conectar. **Nunca:** em quais clínicas atende (grafo
de vínculos) · comissão/impostos/termos financeiros · agenda detalhada.

**Clínica (opt-in):** business_name · cidade/estado · especialidades PROCURADAS (dos
`demand_gap` altos). **Nunca:** dado de paciente · linhas de waitlist · contagem crua de
demanda · receita/`met` · quais profissionais já tem.

**Match:** especialidade + região grossa. **Nunca exposto:** endereço exato · paciente ·
grafo de relacionamentos · financeiro · contagem crua.

## Guardrails derivados (RN-PN-9..11)

- **RN-PN-9** — descoberta opt-in dos DOIS lados (default OFF; desligar tira do diretório na
  hora, não apaga identidade/vínculos).
- **RN-PN-10** — nunca vaza o privado (paciente/financeiro/grafo/contagem crua fora da projeção).
- **RN-PN-11** — descoberta ≠ conexão (o vínculo é sempre `invite→accept` governado).

## Plano

F10.0 (este doc + seção ADR) → F10.1 (profissional descobrível: flag+localização) → F10.2
(clínica descobrível + especialidades procuradas dos demand_gap) → F10.3
(`ProfessionalDiscoveryService` bidirecional, molde `SupplyNetworkService`) → F10.4
(descoberta→convite) → F10b (UI dos dois lados). Cada fatia codifica RN-PN-9..11 como teste.
