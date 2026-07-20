#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Radar B2B — ETL da base aberta da RFB filtrada para o município do Rio de Janeiro (RJ).
Saída: data/radar_rio.db (SQLite). Rodar 1x. ~15-40 min dependendo do disco.
Uso:  python build_radar_rio.py --downloads ./downloads --out ../../data/radar_rio.db \
          --base-month 2024-06 [--incluir-inativas]

O --base-month é o mês da base da RFB (a pasta AAAA-MM de onde os ZIPs vieram).
Fica gravado em radar_meta para a tela mostrar "base de <mês>".
"""
import argparse, csv, glob, io, os, re, sqlite3, sys, zipfile

csv.field_size_limit(10_000_000)

def rows_from_zip(pattern):
    for zpath in sorted(glob.glob(pattern)):
        print(f"  lendo {os.path.basename(zpath)}")
        with zipfile.ZipFile(zpath) as z:
            for name in z.namelist():
                with z.open(name) as f:
                    reader = csv.reader(io.TextIOWrapper(f, encoding="latin-1"), delimiter=";", quotechar='"')
                    for row in reader:
                        yield row

def resolve_tom_rio(downloads):
    for row in rows_from_zip(os.path.join(downloads, "Municipios*.zip")):
        if len(row) >= 2 and row[1].strip().upper() == "RIO DE JANEIRO":
            print(f"Código TOM do Rio de Janeiro: {row[0]}")
            return row[0].strip()
    sys.exit("ERRO: não achei 'RIO DE JANEIRO' em Municipios.zip")

def infer_base_month(downloads, explicit):
    if explicit:
        return explicit.strip()
    # tenta achar um AAAA-MM no caminho de downloads (ex.: .../2024-06/)
    m = re.search(r"(20\d{2})[-_/](0[1-9]|1[0-2])", os.path.abspath(downloads))
    return f"{m.group(1)}-{m.group(2)}" if m else "desconhecido"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--downloads", default="./downloads")
    ap.add_argument("--out", default="../../data/radar_rio.db")
    ap.add_argument("--base-month", default="", help="mês da base RFB, ex.: 2024-06")
    ap.add_argument("--incluir-inativas", action="store_true")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    if os.path.exists(a.out): os.remove(a.out)
    db = sqlite3.connect(a.out)
    db.executescript("""
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE radar_meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE cnaes (codigo TEXT PRIMARY KEY, descricao TEXT);
      CREATE TABLE empresas (
        cnpj TEXT PRIMARY KEY, cnpj_basico TEXT, razao_social TEXT, nome_fantasia TEXT,
        situacao TEXT, data_inicio TEXT, cnae TEXT, cnae_secundarias TEXT,
        logradouro TEXT, numero TEXT, complemento TEXT, bairro TEXT, cep TEXT,
        telefone1 TEXT, telefone2 TEXT, email TEXT,
        natureza_juridica TEXT, capital_social REAL, porte TEXT);
      CREATE TABLE socios (
        cnpj_basico TEXT, nome TEXT, qualificacao TEXT, data_entrada TEXT, faixa_etaria TEXT);
    """)
    base_month = infer_base_month(a.downloads, a.base_month)
    db.execute("INSERT OR REPLACE INTO radar_meta VALUES ('base_month', ?)", (base_month,))
    db.execute("INSERT OR REPLACE INTO radar_meta VALUES ('municipio', 'Rio de Janeiro / RJ')")
    db.commit()
    print(f"Base RFB: {base_month}")

    tom_rio = resolve_tom_rio(a.downloads)
    db.execute("INSERT OR REPLACE INTO radar_meta VALUES ('tom_rio', ?)", (tom_rio,))
    db.commit()

    print("1/4 CNAEs…")
    db.executemany("INSERT OR REPLACE INTO cnaes VALUES (?,?)",
        ((r[0].strip(), r[1].strip()) for r in rows_from_zip(os.path.join(a.downloads, "Cnaes*.zip")) if len(r) >= 2))
    db.commit()

    print("2/4 Estabelecimentos (filtro RJ + Rio)…")
    basicos = set(); buf = []; n = 0
    ins_est = """INSERT OR REPLACE INTO empresas
      (cnpj,cnpj_basico,razao_social,nome_fantasia,situacao,data_inicio,cnae,cnae_secundarias,
       logradouro,numero,complemento,bairro,cep,telefone1,telefone2,email,
       natureza_juridica,capital_social,porte)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)"""
    for r in rows_from_zip(os.path.join(a.downloads, "Estabelecimentos*.zip")):
        if len(r) < 28: continue
        if r[19].strip() != "RJ" or r[20].strip() != tom_rio: continue
        situacao = r[5].strip()
        if not a.incluir_inativas and situacao != "02": continue
        cnpj = f"{r[0]}{r[1]}{r[2]}"
        tel1 = (r[21].strip() + r[22].strip()) or ""
        tel2 = (r[23].strip() + r[24].strip()) or ""
        lograd = " ".join(x for x in [r[13].strip(), r[14].strip()] if x)
        buf.append((cnpj, r[0].strip(), None, r[4].strip(), situacao, r[10].strip(), r[11].strip(),
                    r[12].strip(), lograd, r[15].strip(), r[16].strip(), r[17].strip(),
                    r[18].strip().replace("-", ""), tel1, tel2, r[27].strip().lower()))
        basicos.add(r[0].strip()); n += 1
        if len(buf) >= 20000:
            db.executemany(ins_est, buf); db.commit(); buf = []
            print(f"    {n} estabelecimentos…")
    if buf: db.executemany(ins_est, buf); db.commit()
    print(f"  Total Rio: {n} estabelecimentos ativos" if not a.incluir_inativas else f"  Total Rio: {n}")

    print("3/4 Empresas (razão social/capital/porte)…")
    upd = "UPDATE empresas SET razao_social=?, natureza_juridica=?, capital_social=?, porte=? WHERE cnpj_basico=?"
    buf = []; n = 0
    for r in rows_from_zip(os.path.join(a.downloads, "Empresas*.zip")):
        if len(r) < 6 or r[0].strip() not in basicos: continue
        try: cap = float(r[4].replace(".", "").replace(",", "."))
        except Exception: cap = 0.0
        buf.append((r[1].strip(), r[2].strip(), cap, r[5].strip(), r[0].strip())); n += 1
        if len(buf) >= 20000: db.executemany(upd, buf); db.commit(); buf = []
    if buf: db.executemany(upd, buf); db.commit()
    print(f"  {n} empresas atualizadas")

    print("4/4 Sócios…")
    ins_soc = "INSERT INTO socios VALUES (?,?,?,?,?)"
    buf = []; n = 0
    for r in rows_from_zip(os.path.join(a.downloads, "Socios*.zip")):
        if len(r) < 11 or r[0].strip() not in basicos: continue
        buf.append((r[0].strip(), r[2].strip(), r[4].strip(), r[5].strip(), r[10].strip())); n += 1
        if len(buf) >= 20000: db.executemany(ins_soc, buf); db.commit(); buf = []
    if buf: db.executemany(ins_soc, buf); db.commit()
    print(f"  {n} sócios")

    print("Índices…")
    db.executescript("""
      CREATE INDEX idx_emp_cep ON empresas(cep);
      CREATE INDEX idx_emp_cnae ON empresas(cnae);
      CREATE INDEX idx_emp_porte ON empresas(porte);
      CREATE INDEX idx_soc_basico ON socios(cnpj_basico);
      VACUUM;
    """)
    # contadores úteis para o /status
    total = db.execute("SELECT COUNT(*) FROM empresas").fetchone()[0]
    db.execute("INSERT OR REPLACE INTO radar_meta VALUES ('total_empresas', ?)", (str(total),))
    db.commit()
    db.close()
    print(f"OK → {a.out}  ({total} empresas, base {base_month})")

if __name__ == "__main__":
    main()
