import axios from "axios";
import * as cheerio from "cheerio";
import { upsertPage, getMeta, setMeta, getPageCount, saveDb } from "./db.js";

// Carrega as URLs do arquivo gerado pelo usuário
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface UrlEntry {
  label: string;
  url: string;
}

export function loadUrls(): UrlEntry[] {
  const raw = require("./urls.json") as UrlEntry[];
  // Filtra apenas páginas de docs (ignora playground, plus, etc.)
  const docs = raw.filter((e) => e.url.includes("tailwindcss.com/docs/"));

  const bySlug = new Map<string, UrlEntry>();
  for (const entry of docs) {
    bySlug.set(slugFromUrl(entry.url), entry);
  }

  return [...bySlug.values()];
}

function slugFromUrl(url: string): string {
  return url.replace(/^.*\/docs\//, "").replace(/\?.*$/, "");
}

export function inferSection(label: string, slug: string): string {
  const sectionMap: [RegExp, string][] = [
    [/installation|editor.setup|compatibility|upgrade/i, "Getting Started"],
    [/styling.with|hover.focus|responsive|dark.mode|theme.variables|colors|adding.custom|detecting.classes|functions.and.directives|preflight/i, "Core Concepts"],
    [/aspect.ratio|columns|break|box.decoration|box.sizing|display|float|clear|isolation|object.fit|object.position|overflow|overscroll|position|top.right|visibility|z.index/i, "Layout"],
    // Tables antes de Borders: border-collapse e border-spacing devem ir para Tables
    [/border.collapse|border.spacing|table.layout|caption/i, "Tables"],
    // Borders antes de Flexbox & Grid: evita "border" casar com "order" (substring)
    // Borders antes de Sizing: evita "outline-width" e "border-width" casarem com "width"
    [/border|outline|divide|ring/i, "Borders"],
    // \border\b garante match apenas em "order" isolado, não em "b|order|-*"
    [/flex|\border\b|grid|gap|justify|align|place/i, "Flexbox & Grid"],
    [/padding|margin/i, "Spacing"],
    // Backdrop antes de Effects/Filters: evita "backdrop-filter-opacity" cair em Effects por "opacity"
    [/backdrop/i, "Backdrop Filters"],
    // Effects antes de Typography/Backgrounds: text-shadow e background-blend-mode pertencem a Effects
    [/box.shadow|text.shadow|opacity|mix.blend|background.blend/i, "Effects"],
    // Masks, Interactivity, SVG, Typography e Backgrounds antes de Sizing:
    // evita "*-size", "*-width" e "*-height" caírem na seção genérica de dimensões.
    [/mask/i, "Masks"],
    [/filter|blur|brightness|contrast|drop.shadow|grayscale|hue.rotate|invert|saturate|sepia/i, "Filters"],
    [/transition|animation|backface|perspective/i, "Transitions & Animation"],
    [/rotate|scale|skew|transform|translate|zoom/i, "Transforms"],
    [/accent|appearance|caret|color.scheme|cursor|field.sizing|pointer.events|resize|scroll|touch.action|user.select|will.change/i, "Interactivity"],
    [/fill|stroke/i, "SVG"],
    [/font|letter.spacing|line.clamp|line.height|list.style|text.|tab.size|vertical.align|whitespace|word.break|hyphens|content|^color$/i, "Typography"],
    [/background|gradient/i, "Backgrounds"],
    [/width|height|inline.size|block.size|size/i, "Sizing"],
    [/forced.color|screen.reader/i, "Accessibility"],
  ];

  for (const [re, section] of sectionMap) {
    if (re.test(label) || re.test(slug)) return section;
  }
  return "Other";
}

const GITHUB_API = "https://api.github.com/repos/tailwindlabs/tailwindcss.com/commits";
const CHECK_INTERVAL_MS = 1000 * 60 * 60; // 1 hora entre checks de SHA

function normalizeContent(rawContent: string): string {
  const lines = rawContent
    .replace(/\t/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .filter(Boolean);

  const deduped = lines.filter((line, index) => line !== lines[index - 1]);

  return deduped
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 10000);
}

export async function getLatestCommitSha(): Promise<string | null> {
  try {
    const res = await axios.get(GITHUB_API, {
      params: { path: "src/docs", per_page: 1 },
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "tailwindcss-mcp/1.0",
      },
      timeout: 8000,
    });
    return res.data?.[0]?.sha ?? null;
  } catch {
    return null;
  }
}

export async function fetchPage(entry: UrlEntry): Promise<{
  slug: string;
  label: string;
  url: string;
  title: string;
  description: string;
  content: string;
  section: string;
} | null> {
  const slug = slugFromUrl(entry.url);

  try {
    const res = await axios.get(entry.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);

    const title =
      $("h1").first().text().trim() ||
      $("title").text().replace(/\s*[-–|].*$/, "").trim() ||
      entry.label;

    const description =
      $('meta[name="description"]').attr("content") ||
      $("article p, main p").first().text().trim().slice(0, 300) ||
      "";

    // Remove elementos desnecessários
    $(
      [
        "nav",
        "header",
        "footer",
        "script",
        "style",
        "[data-algolia-exclude]",
        ".sidebar",
        "aside",
        "[role=navigation]",
        "[aria-hidden='true']",
        ".not-prose",
        "[data-rehype-pretty-code-fragment] ~ *",
      ].join(", ")
    ).remove();

    const rawContent =
      $("article").text() ||
      $('[class*="prose"]').text() ||
      $("main").text() ||
      $("body").text();

    const content = normalizeContent(rawContent);

    return {
      slug,
      label: entry.label,
      url: entry.url,
      title,
      description,
      content,
      section: inferSection(entry.label, slug),
    };
  } catch (err: any) {
    console.error(`[crawler] ❌ ${entry.url}: ${err.message}`);
    return null;
  }
}

// Crawl completo de todas as URLs
export async function crawlAll(opts: {
  concurrency?: number;
  onProgress?: (done: number, total: number, slug: string) => void;
} = {}) {
  const { concurrency = 3, onProgress } = opts;
  const urls = loadUrls();
  let done = 0;

  // Processa em lotes para não sobrecarregar o servidor
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((e) => fetchPage(e)));

    for (const page of results) {
      done++;
      if (page) {
        await upsertPage(page);
        onProgress?.(done, urls.length, page.slug);
      } else {
        onProgress?.(done, urls.length, "❌ falhou");
      }
    }

    // Pausa entre lotes para ser gentil com o servidor
    if (i + concurrency < urls.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Salva SHA e timestamp do crawl
  const sha = await getLatestCommitSha();
  if (sha) await setMeta("last_commit_sha", sha);
  await setMeta("last_crawled_at", String(Date.now()));
  await setMeta("last_checked_at", String(Date.now()));
  saveDb();
}

// Verifica se precisa revalidar e faz crawl se necessário
export async function revalidateIfNeeded(): Promise<{
  status: "fresh" | "revalidated" | "check_failed";
  sha?: string;
}> {
  const lastChecked = await getMeta("last_checked_at");
  const now = Date.now();

  // Não checa com mais frequência que CHECK_INTERVAL_MS
  if (lastChecked && now - parseInt(lastChecked) < CHECK_INTERVAL_MS) {
    return { status: "fresh" };
  }

  await setMeta("last_checked_at", String(now));

  const remoteSha = await getLatestCommitSha();
  if (!remoteSha) return { status: "check_failed" };

  const cachedSha = await getMeta("last_commit_sha");
  const pageCount = await getPageCount();

  if (cachedSha === remoteSha && pageCount > 0) {
    return { status: "fresh", sha: remoteSha };
  }

  // SHA diferente ou banco vazio → recrawla
  console.error(`[crawler] Revalidando: ${cachedSha?.slice(0, 7) ?? "vazio"} → ${remoteSha.slice(0, 7)}`);
  await crawlAll({ concurrency: 3 });

  return { status: "revalidated", sha: remoteSha };
}
