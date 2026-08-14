/**
 * htmlSafe — utilitarios de escape para SSR seguro (achado de XSS armazenado).
 *
 * A pagina publica da loja embute um bloco <script type="application/ld+json"> com
 * dados do produto (nome/descricao) que o LOJISTA digita no formulario. JSON.stringify
 * escapa aspas e barra-invertida, mas NAO escapa <, >, & nem os separadores de linha
 * U+2028/U+2029 — entao um nome de produto como </script><script>alert(1)</script>
 * FECHA a tag e executa JavaScript arbitrario no navegador de QUALQUER visitante da loja
 * (XSS armazenado, mesma origem). jsonForScript neutraliza isso escapando esses
 * caracteres como sequencias unicode — o JSON continua VALIDO (o parser desfaz o \uXXXX),
 * mas nao ha como quebrar a </script>.
 */
export function jsonForScript(obj: unknown): string {
  let s = (JSON.stringify(obj) ?? "null").replace(
    /[<>&]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  // U+2028/U+2029 sao terminadores de linha em JS — nao podem aparecer literais no
  // fonte (quebram o regex), entao os tratamos por codigo, sem regex-literal.
  s = s.split(String.fromCharCode(0x2028)).join("\\u2028");
  s = s.split(String.fromCharCode(0x2029)).join("\\u2029");
  return s;
}
