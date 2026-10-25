import fs from "node:fs";
import { isStaleChunkError, claimReload, STALE_CHUNK_WINDOW_MS } from "../src/lib/staleChunk.ts";
let fail = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };

check("chrome", isStaleChunkError(new Error("Failed to fetch dynamically imported module: https://x/assets/A-1.js")));
check("safari", isStaleChunkError("Importing a module script failed."));
check("firefox", isStaleChunkError({ message: "error loading dynamically imported module" }));
check("erro comum não é chunk", !isStaleChunkError(new Error("Cannot read properties of undefined")));
check("null/undefined", !isStaleChunkError(null) && !isStaleChunkError(undefined));

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const st = mem();
check("1ª vez recarrega", claimReload(st, 1_000_000) === true);
check("2ª dentro da janela NÃO recarrega (anti-loop)", claimReload(st, 1_000_000 + 1000) === false);
check("após a janela recarrega de novo", claimReload(st, 1_000_000 + STALE_CHUNK_WINDOW_MS + 1) === true);
check("sem storage (null) ainda registra sem lançar", typeof claimReload(null) === "boolean");
check("storage que lança → false", claimReload({ getItem() { throw new Error("x"); }, setItem() {} }) === false);

const eb = fs.readFileSync("src/features/ErrorBoundary.tsx", "utf8");
const mn = fs.readFileSync("src/main.tsx", "utf8");
check("ErrorBoundary: botão faz reload em chunk obsoleto", /isStaleChunkError\(this\.state\.error\) \? hardReload\(\)/.test(eb));
check("ErrorBoundary: auto-reload no componentDidCatch", /reloadIfStale\(error\)/.test(eb));
check("main: guard instalado", /installStaleChunkGuard\(\);/.test(mn));
process.exit(fail ? 1 : 0);
