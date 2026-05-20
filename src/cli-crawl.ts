#!/usr/bin/env node
/**
 * CLI para crawl manual da documentação do Tailwind CSS.
 *
 * Uso:
 *   npm run crawl          → crawl completo de todas as URLs
 *   npm run crawl:check    → só verifica se há atualização
 */
import {
  crawlAll,
  getLatestCommitSha,
  inferSection,
  loadUrls,
} from "./crawler.js";
import { fixAllSections, getMeta, getPageCount } from "./db.js";

const command = process.argv[2] ?? "crawl";

async function main() {
  if (command === "check") {
    console.log("🔍 Verificando SHA do GitHub...");
    const remoteSha = await getLatestCommitSha();
    const cachedSha = await getMeta("last_commit_sha");
    const count = await getPageCount();

    console.log(`📦 Páginas em cache: ${count}`);
    console.log(`🔖 SHA remoto:  ${remoteSha ?? "indisponível"}`);
    console.log(`🔖 SHA em cache: ${cachedSha ?? "nenhum"}`);

    if (!remoteSha) {
      console.log("⚠️ Não foi possível checar o GitHub (sem conexão?)");
    } else if (remoteSha === cachedSha && count > 0) {
      console.log("✅ Cache está atualizado.");
    } else {
      console.log(
        "🔄 Há atualizações. Execute `npm run crawl` para atualizar.",
      );
    }
    return;
  }

  if (command === "fix-sections") {
    console.log("🔧 Reclassificando seções no cache (sem re-crawl)...\n");
    const updated = await fixAllSections(inferSection);
    const total = await getPageCount();
    console.log(
      `✅ Concluído: ${updated} página(s) corrigida(s) de ${total} no cache.`,
    );
    if (updated === 0) console.log("   Nenhuma seção precisava de correção.");
    return;
  }

  // Crawl completo
  const urls = loadUrls();
  console.log(`🕷️  Iniciando crawl de ${urls.length} páginas...\n`);

  const start = Date.now();
  let ok = 0;
  let fail = 0;

  await crawlAll({
    concurrency: 3,
    onProgress: (done, total, slug) => {
      const failed = slug === "❌ falhou";
      if (failed) fail++;
      else ok++;
      const pct = Math.round((done / total) * 100);
      const bar =
        "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
      process.stdout.write(
        `\r[${bar}] ${pct}% (${done}/${total}) ${failed ? "❌" : "✅"} ${slug.slice(0, 40).padEnd(40)}`,
      );
    },
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n\n✅ Crawl concluído em ${elapsed}s`);
  console.log(`   Sucesso: ${ok} | Falha: ${fail}`);

  const sha = await getMeta("last_commit_sha");
  console.log(`   SHA salvo: ${sha?.slice(0, 7) ?? "indisponível"}`);
}

main().catch((e) => {
  console.error("❌ Erro:", e.message);
  process.exit(1);
});
