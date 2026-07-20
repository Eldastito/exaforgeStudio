# Radar B2B — ETL da base pública da Receita Federal (Rio de Janeiro)

Gera `data/radar_rio.db` (SQLite read-only usado pelo app). Roda **1 vez** na sua
máquina (Windows/Mac/Linux) com **Python 3** — não precisa de bibliotecas extras.

> ⚠️ São ~6–8 GB de download. Rode com internet boa e ~20 GB livres de disco.

## Passo 1 — Baixar a base da RFB

Fonte oficial: <https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/>
→ entre na pasta do **mês mais recente** (formato `AAAA-MM/`). Baixe para
`tools/radar_etl/downloads/`:

- `Empresas0.zip` … `Empresas9.zip`
- `Estabelecimentos0.zip` … `Estabelecimentos9.zip`
- `Socios0.zip` … `Socios9.zip`
- `Cnaes.zip`
- `Municipios.zip`

> Se os nomes vierem com sufixo diferente, tudo bem — o script usa curinga
> (`Empresas*.zip`, etc.). Só mantenha os ZIPs dentro de `downloads/`.

## Passo 2 — Rodar o ETL principal (T01)

```bash
cd tools/radar_etl
python build_radar_rio.py --downloads ./downloads --out ../../data/radar_rio.db --base-month 2024-06
```

Troque `2024-06` pelo mês da pasta que você baixou. Leva ~15–40 min.

**Confere:**
```bash
sqlite3 ../../data/radar_rio.db "SELECT COUNT(*) FROM empresas"
sqlite3 ../../data/radar_rio.db "SELECT razao_social, bairro, telefone1 FROM empresas WHERE cep='22041001' LIMIT 5"
```
Deve retornar centenas de milhares de empresas e nomes reais em Copacabana.

## Passo 3 — Geolocalização por CEP (T02)

A RFB tem CEP mas não tem lat/lon. Baixe o **CNEFE do Censo 2022** do município
do Rio (código IBGE `3304557`) em
<https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/Censo_Demografico_2022/>
(a estrutura de pastas varia; procure o arquivo do município `3304557` ou do
estado RJ). Salve em `downloads/cnefe_rj/` e rode:

```bash
python build_cep_geo.py --cnefe ./downloads/cnefe_rj --out ../../data/radar_rio.db
```

**Confere:**
```bash
sqlite3 ../../data/radar_rio.db "SELECT COUNT(*) FROM cep_geo"     # > 30000
```

> Se o CNEFE estiver fora do ar ou o formato mudar, **pare e me avise**. Para a
> demo dá pra geocodificar só os 3 bairros-alvo pelo fallback do app (mais lento,
> mas suficiente).

## Passo 4 — Apontar o app para a base

O app abre `data/radar_rio.db` por padrão. Se você salvou em outro lugar, defina:

```
RADAR_DB_PATH=/caminho/para/radar_rio.db
```

Pronto — a tela **Radar B2B** no app já enxerga a base. Se a base não existir, a
tela mostra o estado "base não instalada" com este passo a passo.
