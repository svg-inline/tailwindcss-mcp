#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchPages,
  getPage,
  getAllPages,
  getPageCount,
  getMeta,
} from "./db.js";
import { revalidateIfNeeded, loadUrls } from "./crawler.js";

const server = new McpServer({
  name: "tailwindcss-mcp",
  version: "2.0.0",
});

// Revalidação lazy: roda em background quando o servidor inicia
let revalidationPromise: Promise<any> | null = null;
function ensureRevalidated() {
  if (!revalidationPromise) {
    revalidationPromise = revalidateIfNeeded().catch((e) =>
      console.error("[mcp] revalidate error:", e.message)
    );
  }
  return revalidationPromise;
}

function normalizeSlugText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugTokens(value: string): string[] {
  return normalizeSlugText(value)
    .split(" ")
    .filter((token) => token.length >= 3);
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function similarityScore(input: string, page: any): number {
  const querySlug = normalizeSlugText(input).replace(/\s+/g, "-");
  const pageSlug = String(page.slug ?? "").toLowerCase();
  const pageTitle = normalizeSlugText(page.title || page.label || "");
  const queryTokens = slugTokens(input);
  const pageTokens = new Set([...slugTokens(pageSlug), ...slugTokens(pageTitle)]);
  const distance = levenshteinDistance(querySlug, pageSlug);
  const maxLength = Math.max(querySlug.length, pageSlug.length, 1);
  const similarity = 1 - distance / maxLength;

  let score = 0;
  let tokenMatches = 0;

  if (pageSlug === querySlug) score += 1000;
  if (pageSlug.startsWith(querySlug)) score += 240;
  if (querySlug.length >= 4 && pageSlug.includes(querySlug)) score += 160;

  for (const token of queryTokens) {
    if (pageTokens.has(token)) {
      tokenMatches++;
      score += 80;
    }
  }

  if (similarity >= 0.58) score += Math.round(similarity * 140);
  if (queryTokens.length >= 2 && tokenMatches < 2 && similarity < 0.58) return 0;

  return score;
}

function formatSimilarPages(input: string, pages: any[]): string {
  return pages
    .map((page) => ({ page, score: similarityScore(input, page) }))
    .filter(({ score }) => score >= 80)
    .sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug))
    .slice(0, 5)
    .map(({ page }) => `\`${page.slug}\` — ${page.title || page.label}`)
    .join("\n");
}

// ─────────────────────────────────────────────
// TOOL: search_tailwind_docs
// ─────────────────────────────────────────────
server.tool(
  "search_tailwind_docs",
  "Busca na documentação oficial do Tailwind CSS v4 (cache SQLite local, revalidado automaticamente por commit SHA do GitHub). Use para encontrar utilities, conceitos ou qualquer tópico.",
  {
    query: z
      .string()
      .describe(
        "Termo de busca (ex: 'flex gap', 'dark mode', 'hover states', 'grid responsive')"
      ),
    limit: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe("Número máximo de resultados"),
  },
  async ({ query, limit }) => {
    ensureRevalidated();

    const count = await getPageCount();
    if (count === 0) {
      return {
        content: [
          {
            type: "text",
            text: "⚠️ Banco de dados vazio. Execute `npm run crawl` para popular o cache inicial.",
          },
        ],
      };
    }

    const pages = await searchPages(query, limit);

    if (pages.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Nenhum resultado para "${query}". Tente outros termos ou use \`list_tailwind_pages\` para ver todas as páginas.`,
          },
        ],
      };
    }

    const results = pages
      .map(
        (p, i) =>
          `## ${i + 1}. ${p.title || p.label}\n` +
          `**Seção:** ${p.section}  |  **URL:** ${p.url}\n\n` +
          (p.description ? `> ${p.description}\n\n` : "") +
          `${p.excerpt}...\n`
      )
      .join("\n---\n\n");

    const lastCrawled = await getMeta("last_crawled_at");
    const sha = await getMeta("last_commit_sha");
    const footer = lastCrawled
      ? `\n\n---\n*Cache: ${new Date(parseInt(lastCrawled)).toLocaleString("pt-BR")} | SHA: ${sha?.slice(0, 7) ?? "?"}*`
      : "";

    return {
      content: [
        {
          type: "text",
          text: `# Resultados para "${query}"\n\n${results}${footer}`,
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// TOOL: get_tailwind_doc_page
// ─────────────────────────────────────────────
server.tool(
  "get_tailwind_doc_page",
  "Retorna o conteúdo completo de uma página da documentação do Tailwind CSS pelo slug.",
  {
    slug: z
      .string()
      .describe(
        "Slug da página (ex: 'flex', 'grid-template-columns', 'dark-mode', 'hover-focus-and-other-states')"
      ),
  },
  async ({ slug }) => {
    ensureRevalidated();

    const page = await getPage(slug);

    if (!page) {
      const all = await getAllPages();
      const similar = formatSimilarPages(slug, all);

      return {
        content: [
          {
            type: "text",
            text:
              `Página \`${slug}\` não encontrada no cache.\n\n` +
              (similar
                ? `**Similares:**\n${similar}`
                : "Use `list_tailwind_pages` para ver todos os slugs."),
          },
        ],
        isError: true,
      };
    }

    const fetchedAt = page.fetched_at
      ? new Date(page.fetched_at).toLocaleString("pt-BR")
      : "?";

    return {
      content: [
        {
          type: "text",
          text:
            `# ${page.title || page.label}\n` +
            `**Seção:** ${page.section}  |  **URL:** ${page.url}  |  **Cache:** ${fetchedAt}\n\n` +
            (page.description ? `> ${page.description}\n\n` : "") +
            page.content,
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// TOOL: list_tailwind_pages
// ─────────────────────────────────────────────
server.tool(
  "list_tailwind_pages",
  "Lista todas as páginas da documentação do Tailwind CSS no cache, agrupadas por seção.",
  {
    section: z
      .string()
      .optional()
      .describe("Filtrar por seção específica (opcional)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(50)
      .describe("Número máximo de páginas retornadas"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Número de páginas para pular antes de listar"),
  },
  async ({ section, limit, offset }) => {
    ensureRevalidated();

    const all = await getAllPages();
    const filtered = section
      ? all.filter((p) => p.section.toLowerCase().includes(section.toLowerCase()))
      : all;

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: section
              ? `Nenhuma página na seção "${section}".`
              : "Cache vazio. Execute `npm run crawl`.",
          },
        ],
      };
    }

    const paginated = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;

    if (paginated.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Nenhuma página a partir do offset ${offset}. Total disponível: ${filtered.length}.`,
          },
        ],
      };
    }

    // Agrupa por seção
    const bySection: Record<string, typeof paginated> = {};
    for (const p of paginated) {
      const s = p.section || "Other";
      if (!bySection[s]) bySection[s] = [];
      bySection[s].push(p);
    }

    const output = Object.entries(bySection)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([sec, pages]) =>
          `## ${sec}\n` +
          (pages as any[])
            .map((p) => `- \`${p.slug}\` — ${p.title || p.label}`)
            .join("\n")
      )
      .join("\n\n");

    const start = offset + 1;
    const end = offset + paginated.length;
    const footer = hasMore
      ? `\n\n*Mostrando ${start}-${end} de ${filtered.length}. Use offset=${offset + limit} para ver mais.*`
      : `\n\n*Total: ${filtered.length} página(s).*`;

    return {
      content: [
        {
          type: "text",
          text: `# Páginas no Cache (${paginated.length}/${filtered.length})\n\n${output}${footer}`,
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// TOOL: get_tailwind_cache_status
// ─────────────────────────────────────────────
server.tool(
  "get_tailwind_cache_status",
  "Mostra o status do cache: quantas páginas estão armazenadas, quando foi o último crawl e o SHA do commit da documentação.",
  {},
  async () => {
    const count = await getPageCount();
    const lastCrawled = await getMeta("last_crawled_at");
    const lastChecked = await getMeta("last_checked_at");
    const sha = await getMeta("last_commit_sha");
    const totalUrls = loadUrls().length;

    return {
      content: [
        {
          type: "text",
          text:
            `# Status do Cache — Tailwind CSS MCP\n\n` +
            `- **Páginas no cache:** ${count} / ${totalUrls}\n` +
            `- **Último crawl:** ${lastCrawled ? new Date(parseInt(lastCrawled)).toLocaleString("pt-BR") : "nunca"}\n` +
            `- **Última verificação de SHA:** ${lastChecked ? new Date(parseInt(lastChecked)).toLocaleString("pt-BR") : "nunca"}\n` +
            `- **Commit SHA:** ${sha ?? "desconhecido"}\n\n` +
            (count === 0
              ? `⚠️ Cache vazio. Execute \`npm run crawl\` no terminal para popular.\n`
              : `✅ Cache pronto.\n`),
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// TOOL: force_revalidate
// ─────────────────────────────────────────────
server.tool(
  "force_revalidate_tailwind_cache",
  "Força uma verificação imediata do SHA do GitHub e recrawla as páginas se houver atualizações.",
  {},
  async () => {
    revalidationPromise = null; // reseta para forçar novo check
    const result = await revalidateIfNeeded();
    const count = await getPageCount();

    return {
      content: [
        {
          type: "text",
          text:
            `# Revalidação do Cache\n\n` +
            `- **Status:** ${result.status}\n` +
            `- **SHA:** ${result.sha?.slice(0, 7) ?? "indisponível"}\n` +
            `- **Páginas no cache:** ${count}\n`,
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[tailwindcss-mcp] v2.0 iniciado");

  // Inicia revalidação em background
  ensureRevalidated();
}

main().catch((err) => {
  console.error("[tailwindcss-mcp] erro fatal:", err);
  process.exit(1);
});
