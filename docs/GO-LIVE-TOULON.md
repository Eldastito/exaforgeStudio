# Go-live TOULON — checklist acionável (Caminho A)

Passos para a **TOULON começar a operar no ZappFlow**, independente da
integração com o Alterdata (que é Fase 2 — ver
[`INTEGRACAO-ALTERDATA-PERGUNTAS.md`](INTEGRACAO-ALTERDATA-PERGUNTAS.md)).

> Legenda de responsável: **[TOULON]** = ação do lojista/time · **[ZF]** =
> plataforma/nós · **[EMERSON]** = decisão/config sua.
> Marque `[x]` quando "pronto quando" estiver satisfeito.

---

## 1. Conta & plano
- [ ] **[EMERSON]** Confirmar a org TOULON ativa no Master Admin e o plano
  atribuído (hoje **mockado** — cobrança real depende de ASAAS + jurídico).
- **Pronto quando:** a TOULON entra no painel sem bloqueio de billing.

## 2. Canais de atendimento (o passo que mais trava)
- [ ] **[TOULON/EMERSON]** Conectar o **WhatsApp oficial** da loja (número +
  provedor/Meta) no painel de Canais.
- [ ] **[TOULON]** (opcional) Conectar **Instagram Direct** (config Meta).
- [ ] **[EMERSON]** Cadastrar o(s) **gestor(es) autorizado(s)** no modo Zapp
  (número que fala com a "IA do negócio").
- **Pronto quando:** um WhatsApp de teste recebe resposta da IA e o gestor
  consegue cadastrar um produto por foto.

## 3. Catálogo & estoque
- [ ] **[TOULON]** Carregar os produtos — por **foto no WhatsApp** (vitrinista),
  **import PDF/CSV** (Catálogo), ou cadastro manual.
- [ ] **[TOULON]** Definir preço de venda em cada peça (sem preço = fora da
  vitrine, por decisão de produto).
- [ ] **[TOULON]** Conferir quantidades de estoque (o WhatsApp respeita
  `storefront_visible` e some quando zera, se `auto_hide_out_of_stock` ligado).
- **Pronto quando:** produtos aparecem na vitrine com preço, foto e estoque.

## 4. Equipe & permissões (RBAC)
- [ ] **[EMERSON]** Criar os usuários da TOULON.
- [ ] **[EMERSON]** Atribuir perfis (templates Dono/Gerente/Vendedor/
  Estoquista/Financeiro/Atendente ou perfil customizado).
- **Pronto quando:** cada colaborador entra e vê só o que o perfil libera.

## 5. LGPD & consentimento
- [ ] **[EMERSON]** Configurar consentimento na aba LGPD (a TOULON é a
  **controladora** dos dados dos clientes dela).
- [ ] **[EMERSON]** Revisar categorias pré-populadas por vertical (moda).
- **Pronto quando:** a política de consentimento está publicada e ativa.

## 6. Pagamento (se vender com cartão online)
- [ ] **[EMERSON]** Configurar o **Link de Pagamento Stone/Pagar.me** (Fase 1,
  já implementada) no `PaymentService`.
- **Pronto quando:** um pedido de teste gera link e o webhook confirma o pago.
- _Fora de escopo do piloto:_ checkout transparente (Fase 2) e maquininha
  presencial (Fase 3) — ver ADR-100.

## 7. Backup & redundância (⚠️ importante)
- [ ] **[ZF/EMERSON]** **Habilitar o S3** (ou off-site nosso) — sem isso a
  "redundância" cai no disco local e não é redundância real.
- [ ] **[EMERSON]** (opcional) Ligar o backup opt-in pro **Google Drive do
  dono** (Drive já conectado).
- **Pronto quando:** o `backupPass` roda e grava cópia no S3/Drive.

## 8. Loja virtual — publicação
- [ ] **[EMERSON]** Definir slug/título/tema/`whatsapp_number` da vitrine.
- [ ] **[EMERSON]** Marcar a loja como **publicada**.
- **Pronto quando:** a URL pública abre com os produtos.

## 9. Vitrinista IA (já pronta — opcional ligar)
- [ ] **[EMERSON]** Ligar o **Provador Virtual** (Fashion Studio) nas configs.
- [ ] **[TOULON]** Subir **avatares preset** (modelos por corpo/tom de pele).
- [ ] **[TOULON]** Cadastrar peças novas → "montar vitrine" → aprovar looks →
  publicar (fotos do avatar vestindo).
- **Pronto quando:** um look aparece na galeria pública da loja.

## 10. Teste de fumaça ponta a ponta
- [ ] Cliente chega pelo WhatsApp → IA atende → link da loja → pedido → pagamento
  → confirmação. Um ciclo completo, com dado real de teste.
- **Pronto quando:** o ciclo fecha sem intervenção manual.

## 11. Treinamento do time
- [ ] **[EMERSON/TOULON]** 30 min com o time: cadastro por foto, Kanban de
  looks, atendimento assistido, fechamento.

---

### Dependências externas que NÃO bloqueiam operar
- **ASAAS + revisão jurídica** → só para a **cobrança real** da assinatura
  (roda como cortesia interna até fechar).
- **Alterdata** → Fase 2 (sincronização com o ERP). Ver documento de perguntas.
