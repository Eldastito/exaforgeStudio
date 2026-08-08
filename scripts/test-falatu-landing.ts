// Landing page do Fala Tu servida em /fala-tu (estático via public/ → dist/).
//
// A página é um HTML pronto (design "TasteMotion") com CTA "Escolher meu plano"
// + faixa de planos, servida como asset estático pelo próprio app (public/
// é copiado pra dist/ no build; express.static roda ANTES do catch-all do SPA).
// Este teste guarda o essencial pra não quebrar em silêncio: o arquivo existe,
// é um doc completo, a CTA/planos estão lá, o vídeo foi EXTRAÍDO (não voltou a
// virar base64 gigante no HTML) e o mp4 é um arquivo real.
//
// Sem DB, sem rede — só lê os arquivos do repo.

import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failures++;
}

const root = process.cwd();
const dir = path.join(root, "public", "fala-tu");
const htmlPath = path.join(dir, "index.html");
const mp4Path = path.join(dir, "hero.mp4");

check("public/fala-tu/index.html existe", fs.existsSync(htmlPath));
check("public/fala-tu/hero.mp4 existe", fs.existsSync(mp4Path));

const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : "";

// Documento completo (servido direto no domínio — não é artifact, precisa das tags).
check("é um documento HTML completo (<!doctype html>)", /^\s*<!doctype html>/i.test(html));
check("tem <html> e </body>", html.includes("<html") && html.includes("</body>"));

// CTA de conversão + faixa de planos.
check("CTA aponta pra #planos (nav/hero/fecho)", (html.match(/href="#planos"/g) || []).length >= 3);
check("faixa de planos com id=planos", html.includes('id="planos"'));
check("esqueleto com 3 planos", (html.match(/class="plano-card/g) || []).length === 3);
check("card Pro em destaque + badge", html.includes("plano-card destaque") && html.includes("Mais popular"));
check("cada plano tem botão de checkout (data-plan)", (html.match(/data-plan="/g) || []).length === 3);

// Vídeo EXTRAÍDO pro arquivo (não pode ter voltado a ser base64 no HTML — o
// motivo de existir esta fatia é não commitar ~14MB de base64 no git).
check("HTML referencia /fala-tu/hero.mp4", (html.match(/\/fala-tu\/hero\.mp4/g) || []).length >= 1);
check("nenhum vídeo base64 no HTML", !html.includes("data:video"));
check("HTML enxuto (< 3MB, sem o vídeo embutido)", Buffer.byteLength(html, "utf8") < 3 * 1024 * 1024);

// Libs de animação embutidas inline (robustez: não depende de CDN externo).
check("GSAP inline (sem <script src> externo)", html.includes("GSAP 3.15.0") && !/\<script[^>]*src="https?:\/\//.test(html));
check("Lenis inicializado", html.includes("new Lenis"));

// mp4 real (assinatura ftyp nos bytes 4..8).
if (fs.existsSync(mp4Path)) {
  const head = fs.readFileSync(mp4Path).subarray(4, 8).toString("latin1");
  check("hero.mp4 tem assinatura MP4 (ftyp)", head === "ftyp");
  check("hero.mp4 tem tamanho plausível (> 500KB)", fs.statSync(mp4Path).size > 500 * 1024);
}

console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
