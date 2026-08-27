/**
 * SEED — Studio Visual Recipes (ADR-194 F1).
 *
 * Cria os 6 recipes iniciais discutidos no PRD-PEL-01 §12.4 + os aliases
 * dos slash-commands. Idempotente: recipe/alias já presentes → skip.
 *
 * Uso: npm run seed:studio-visual-recipes
 */
import { StudioVisualRecipeService } from "../src/server/StudioVisualRecipeService.js";

async function main() {
  console.log("\n=== Seed Studio Visual Recipes (ADR-194 F1) ===\n");
  const result = StudioVisualRecipeService.seedInitialRecipes();
  console.log(`recipes criados: ${result.created.length}${result.created.length ? ` (${result.created.join(", ")})` : ""}`);
  console.log(`aliases anexados: ${result.aliases_added}`);
  const total = StudioVisualRecipeService.list().length;
  console.log(`\ntotal de recipes ativos no db: ${total}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
