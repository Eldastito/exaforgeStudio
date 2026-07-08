# Ambientes do ZappFlow — local, staging e produção

Este guia descreve o esquema de 3 ambientes que evita "quebrar produção" ao
mudar código. Todo mundo que mexer no projeto precisa entender essas
regras antes de tocar em qualquer coisa.

---

## Panorama

| Ambiente | Onde roda | Branch git | Deploy | Dados |
|---|---|---|---|---|
| **Local** | Seu computador (`localhost:5173`) | qualquer branch de trabalho | Manual (`npm run dev`) | `./data/zappflow.db` no seu HD |
| **Staging** | Coolify, VPS Hostinger, subdomínio `staging.*` | `staging` | Auto ao dar push em `staging` | `/data-staging/zappflow.db` na VPS |
| **Produção** | Coolify, VPS Hostinger, domínio principal | `main` | Auto ao dar push em `main` | `/data/zappflow.db` na VPS |

**Regra de ouro:** nunca dar push direto em `main`. Fluxo sempre:

```
branch de trabalho → PR → merge para main (após validar em staging)
```

---

## Nível 1 — Ambiente local

Roda tudo no seu computador. Zero custo, zero risco. É onde 90% do trabalho
acontece.

### Setup (uma vez)

1. **Clonar o repo:**
   ```bash
   git clone https://github.com/Eldastito/exaforgeStudio.git
   cd exaforgeStudio
   ```

2. **Instalar dependências:**
   ```bash
   npm install
   ```

3. **Criar `.env.local` a partir do template:**
   ```bash
   cp .env.local.example .env.local
   ```

4. **Editar `.env.local`** e preencher os campos obrigatórios:
   - `JWT_SECRET` → gera com `openssl rand -hex 32`
   - `ENCRYPTION_KEY` → outra chave, também com `openssl rand -hex 32`
   - `OPENAI_API_KEY` → sua chave, mas **crie uma chave separada só pra dev** com budget baixo ($5-10/mês)

5. **Rodar:**
   ```bash
   npm run dev
   ```

6. **Acessar:** `http://localhost:5173`

### Regras do ambiente local

- **NUNCA** aponta `.env.local` pro banco de produção ou pra chaves de produção.
- **NUNCA** conecta WhatsApp real do cliente aqui — se testar WhatsApp, usa
  seu número pessoal em uma **instância Evolution separada** (`EVOLUTION_INSTANCE_NAME=ExaFoDEV` ou similar).
- **Reinicia limpo** quando quiser: apaga `./data/zappflow.db` e sobe de novo.

### Verificação rápida

Depois de subir `npm run dev`, teste:

```bash
curl http://localhost:3000/api/health   # se existir a rota
```

Ou abre `http://localhost:5173` no navegador e faz login com `admin/admin`
(seed de teste — só em NODE_ENV=development).

---

## Nível 2 — Ambiente staging

Uma segunda aplicação na sua VPS Coolify, rodando o branch `staging`,
totalmente isolada do banco/canais de produção. Aqui você testa mudanças
grandes ANTES de promover pra prod.

### Setup inicial (uma vez, 2-4h)

Este é o passo-a-passo pra criar o ambiente staging pela primeira vez.

#### Passo 1 — DNS (na Hostinger)

Cria um subdomínio apontando pra mesma VPS:

- Nome: `staging.zapflowia`  (ou o padrão que preferir)
- Tipo: `A`
- Valor: IP público da sua VPS (mesmo IP da produção)
- TTL: 300

**Aguarda propagar** (5-30 min). Testa: `ping staging.zapflowia.tesseractauto.com.br`.

#### Passo 2 — Segunda instância Evolution (WhatsApp de teste)

O staging precisa de um WhatsApp **separado do produção** pra não misturar
mensagens de cliente com testes.

Opções:
- **Melhor:** um chip de teste (linha extra, R$15/mês) → escaneia QR em uma
  instância Evolution `ExaFoSTAGING`.
- **Aceitável:** teu próprio WhatsApp pessoal em uma segunda instância — MAS
  cuidado: se derrubar a sessão, você perde WhatsApp por 15-30min.
- **Não recomendado:** deixar staging sem WhatsApp (perde o teste E2E).

Cria nova instância no seu Evolution:
- Nome: `ExaFoSTAGING`
- Aponta pra chip de teste

Anota o `EVOLUTION_API_KEY` da nova instância.

#### Passo 3 — Nova aplicação no Coolify

No painel do Coolify:

1. **New Application** (mesma VPS)
2. **Source:** GitHub → repo `Eldastito/exaforgeStudio`
3. **Branch:** `staging`
4. **Auto Deploy:** ligado (redeploy quando `staging` receber push)
5. **Nome da aplicação:** `zappflow-staging`
6. **Domínio:** `staging.zapflowia.tesseractauto.com.br` (o subdomínio do
   passo 1)
7. **Build command:** `npm ci && npm run build`
8. **Start command:** `npm start`
9. **Volume persistente:** `/data-staging` (importante: caminho DIFERENTE de
   produção pra bancos não se misturarem)

#### Passo 4 — Variáveis de ambiente da staging

Copia o conteúdo de `.env.staging.example` (na raiz do repo) e configura no
painel do Coolify. As MAIS IMPORTANTES:

```
NODE_ENV=production
DATA_DIR=/data-staging
APP_URL=https://staging.zapflowia.tesseractauto.com.br
ALLOWED_ORIGINS=https://staging.zapflowia.tesseractauto.com.br
CORS_ORIGIN=https://staging.zapflowia.tesseractauto.com.br

# Segredos SEPARADOS da produção — gera com openssl rand -hex 32
JWT_SECRET=<novo>
ENCRYPTION_KEY=<novo>

# OpenAI: chave separada com budget baixo (recomendado) OU a mesma
OPENAI_API_KEY=<mesma ou nova>
AI_DAILY_LIMIT=100

# Evolution SEPARADA (instância staging do passo 2)
EVOLUTION_BASE_URL=<url do evolution>
EVOLUTION_API_KEY=<key da instância ExaFoSTAGING>
EVOLUTION_INSTANCE_NAME=ExaFoSTAGING

# Master admin: outro email OU o mesmo (você escolhe)
MASTER_ADMIN_EMAIL=eldastito@gmail.com

# Rate limit: LIGADO em staging também (pra simular prod)
ENABLE_RATE_LIMIT=true

# Meta / Instagram / Google: DEIXA em branco por enquanto (ativa só se
# for testar integração específica)
```

#### Passo 5 — Deploy inicial

No Coolify, dispara o primeiro deploy da nova app. Aguarda o build (~2-4min).

Quando subir, acessa: `https://staging.zapflowia.tesseractauto.com.br`.
Se abrir o app, deu certo.

#### Passo 6 — Confirma isolamento

- **No login da staging**, cria uma org de teste (ex.: "Teste Staging").
- **Confirma no painel Coolify** que a produção NÃO recebeu esse dado:
  - Terminal do container de PROD: `sqlite3 /data/zappflow.db "SELECT COUNT(*) FROM organization_settings;"`
  - Terminal do container de STAGING: `sqlite3 /data-staging/zappflow.db "SELECT COUNT(*) FROM organization_settings;"`
  - Os números devem ser DIFERENTES. Se forem iguais, o `DATA_DIR` está mal configurado — REVISA antes de continuar.

### Fluxo de trabalho com staging

Depois do setup, o fluxo diário é:

```bash
# 1. Sai da main, cria branch de trabalho
git checkout main
git pull
git checkout -b feature/minha-mudanca

# 2. Faz a mudança. Testa localmente.
npm run dev

# 3. Quando quiser validar em ambiente REMOTO (WhatsApp real de teste,
#    dados persistidos, etc.), sobe pro staging:
git checkout staging
git merge feature/minha-mudanca
git push origin staging
# Coolify auto-deploy: espera 3-5min, testa em https://staging.zapflowia...

# 4. Se ficou bom em staging → cria PR pra main:
git checkout feature/minha-mudanca
git push origin feature/minha-mudanca
# Abre PR no GitHub → CI verde → merge

# 5. Se ficou ruim em staging → volta a mexer:
git checkout feature/minha-mudanca
# ... conserta ...
git checkout staging
git reset --hard main   # descarta a versão ruim de staging
git merge feature/minha-mudanca
git push --force-with-lease origin staging
```

### Manutenção da staging

- **Reset periódico** (mensal): apaga o `zappflow.db` da staging pra ficar
  limpo. Comando no terminal do container de staging:
  ```bash
  rm /data-staging/zappflow.db*
  ```
  Depois reinicia o container. O boot cria banco novo, você recadastra a
  org de teste.

- **Sincronizar com main**: quando main avança, dá `merge` de main na
  staging pra testar mudanças combinadas:
  ```bash
  git checkout staging
  git merge origin/main
  git push origin staging
  ```

- **Custo:** ~R$5-15/mês em recursos extras da VPS + custo do chip de
  teste + budget do OpenAI de dev. Total: ~R$30-60/mês.

---

## Nível 3 — Produção

Sua VPS Hostinger + Coolify + branch `main` + banco `/data/zappflow.db` +
WhatsApp/Instagram reais dos clientes.

### Regras

- **NUNCA** push direto em `main` — sempre via PR.
- **NUNCA** roda script destrutivo (rm, DROP TABLE, DELETE FROM sem WHERE)
  no container de produção sem backup imediato antes.
- **NUNCA** compartilha a senha do Coolify.
- **SEMPRE** faz mudança grande em `feature branch` → staging → main.
- **SEMPRE** consulta `docs/DEPLOY.md` pra procedimentos operacionais
  (rotação de chave, backup, migração de storage).

---

## Referência rápida — mapa de `NODE_ENV`

| Ambiente | `NODE_ENV` | Efeitos |
|---|---|---|
| Local | `development` | Rate limit relaxado, logs verbosos, seed admin/admin permitido |
| Staging | `production` | Igual a prod (build compilado, rate limit ligado, log JSON) |
| Produção | `production` | Idem |

Staging usa `NODE_ENV=production` **intencionalmente** — pra reproduzir o
comportamento real. O que diferencia é o `DATA_DIR`, `APP_URL` e as
credenciais isoladas.

---

## Referência rápida — checklist antes de promover pra produção

Antes de aceitar um PR em `main`, confirma que:

- [ ] Testou local (`npm run dev`) sem erro
- [ ] Se a mudança envolve DB (migração, coluna nova) — testou em staging
- [ ] Se a mudança envolve IA (novo prompt, sanitizer) — testou em staging
- [ ] Se a mudança envolve rota nova pública — testou rate limit em staging
- [ ] CI verde (`.github/workflows/ci.yml`)
- [ ] Nenhum segredo commitado (verifica com `git diff main -- .env*`)
- [ ] O deploy da staging subiu SEM erro no log do Coolify

Se qualquer item acima é "não", NÃO promove.
