#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Radar B2B — T02: monta a tabela cep_geo (CEP -> lat/lon) no radar_rio.db a partir
do CNEFE/IBGE (Censo 2022), agregando por CEP (média das coordenadas).

O CNEFE do município do Rio (código IBGE 3304557) vem em CSV separado por ';'.
Os nomes de coluna do header contêm CEP / LATITUDE / LONGITUDE — este script
identifica as colunas PELO HEADER (não por posição fixa), porque o layout varia.

Uso:
  python build_cep_geo.py --cnefe ./downloads/cnefe_rj --out ../../data/radar_rio.db

--cnefe pode ser um arquivo .csv/.zip OU uma pasta com vários (lê todos).
Critério de aceite: SELECT COUNT(*) FROM cep_geo > 30000; CEPs de
Copacabana/Tijuca/Barra com lat ≈ -22.9, lon ≈ -43.2.
"""
import argparse, csv, glob, io, os, sqlite3, sys, zipfile

csv.field_size_limit(10_000_000)

def find_col(header, *needles):
    """Índice da 1ª coluna cujo nome (upper, sem acento comum) contém algum needle."""
    up = [h.strip().upper() for h in header]
    for i, name in enumerate(up):
        for nd in needles:
            if nd in name:
                return i
    return -1

def parse_coord(v):
    v = (v or "").strip().replace(",", ".")
    try:
        f = float(v)
        return f if -90 <= f <= 90 or -180 <= f <= 180 else None
    except Exception:
        return None

def iter_csv_sources(path):
    """Gera (nome, file-like texto) para cada CSV, seja arquivo solto, .zip ou pasta."""
    targets = []
    if os.path.isdir(path):
        for ext in ("*.csv", "*.CSV", "*.zip", "*.ZIP"):
            targets += glob.glob(os.path.join(path, "**", ext), recursive=True)
    else:
        targets = [path]
    for t in sorted(set(targets)):
        if t.lower().endswith(".zip"):
            with zipfile.ZipFile(t) as z:
                for name in z.namelist():
                    if name.lower().endswith((".csv", ".txt")):
                        with z.open(name) as f:
                            yield f"{os.path.basename(t)}:{name}", io.TextIOWrapper(f, encoding="latin-1", errors="replace")
        else:
            yield os.path.basename(t), open(t, "r", encoding="latin-1", errors="replace")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cnefe", required=True, help="arquivo/pasta do CNEFE do Rio (3304557)")
    ap.add_argument("--out", default="../../data/radar_rio.db")
    a = ap.parse_args()
    if not os.path.exists(a.out):
        sys.exit(f"ERRO: {a.out} não existe. Rode primeiro o build_radar_rio.py (T01).")

    # acumula soma/contagem por CEP para tirar a média sem guardar tudo em memória por linha
    acc = {}  # cep -> [soma_lat, soma_lon, n]
    total_lines = 0
    for src_name, fh in iter_csv_sources(a.cnefe):
        print(f"  lendo {src_name}")
        reader = csv.reader(fh, delimiter=";", quotechar='"')
        try:
            header = next(reader)
        except StopIteration:
            continue
        ci_cep = find_col(header, "CEP")
        ci_lat = find_col(header, "LATITUDE", "LAT")
        ci_lon = find_col(header, "LONGITUDE", "LON")
        if min(ci_cep, ci_lat, ci_lon) < 0:
            print(f"    (pulei: header sem CEP/LAT/LON -> {header[:6]}…)")
            continue
        for row in reader:
            if len(row) <= max(ci_cep, ci_lat, ci_lon):
                continue
            cep = (row[ci_cep] or "").strip().replace("-", "")
            if len(cep) != 8 or not cep.isdigit():
                continue
            lat = parse_coord(row[ci_lat]); lon = parse_coord(row[ci_lon])
            if lat is None or lon is None:
                continue
            slot = acc.get(cep)
            if slot is None:
                acc[cep] = [lat, lon, 1]
            else:
                slot[0] += lat; slot[1] += lon; slot[2] += 1
            total_lines += 1
            if total_lines % 500000 == 0:
                print(f"    {total_lines} endereços, {len(acc)} CEPs…")

    if not acc:
        sys.exit("ERRO: nenhum CEP com coordenada foi lido. Confira o caminho do CNEFE e o header.")

    db = sqlite3.connect(a.out)
    db.executescript("""
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      DROP TABLE IF EXISTS cep_geo;
      CREATE TABLE cep_geo (cep TEXT PRIMARY KEY, lat REAL, lon REAL, n INTEGER);
    """)
    db.executemany(
        "INSERT OR REPLACE INTO cep_geo VALUES (?,?,?,?)",
        ((cep, s[0] / s[2], s[1] / s[2], s[2]) for cep, s in acc.items()),
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_cepgeo_cep ON cep_geo(cep)")
    db.execute("INSERT OR REPLACE INTO radar_meta VALUES ('total_ceps', ?)", (str(len(acc)),))
    db.commit(); db.close()
    print(f"OK → cep_geo: {len(acc)} CEPs (de {total_lines} endereços)")

if __name__ == "__main__":
    main()
