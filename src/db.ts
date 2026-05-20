import { createRequire } from "module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Caminho do banco de dados em disco
export const DB_PATH = join(__dirname, "..", "data", "tailwind.db");
export const DATA_DIR = join(__dirname, "..", "data");

let _SQL: any = null;
let _db: any = null;

async function getSQL() {
  if (_SQL) return _SQL;
  const initSqlJs = require("sql.js/dist/sql-asm.js");
  _SQL = await initSqlJs();
  return _SQL;
}

export async function openDb() {
  if (_db) return _db;
  const SQL = await getSQL();

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
    initSchema(_db);
  } else {
    _db = new SQL.Database();
    initSchema(_db);
    saveDb();
  }
  return _db;
}

function initSchema(db: any) {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pages (
      slug        TEXT PRIMARY KEY,
      label       TEXT,
      url         TEXT,
      title       TEXT,
      description TEXT,
      content     TEXT,
      section     TEXT,
      fetched_at  INTEGER
    )
  `);

  ensurePagesFts(db);
}

function getSingleValue(db: any, sql: string): any | null {
  const result = db.exec(sql);
  return result[0]?.values[0]?.[0] ?? null;
}

function createPagesFts(db: any) {
  // FTS4 (sql.js não tem FTS5). Mantemos uma tabela FTS própria, porque o
  // modo content="pages" exige docid/rowid sincronizado com a tabela pages.
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts
    USING fts4(slug, label, title, description, content)
  `);
}

function rebuildPagesFts(db: any) {
  db.run(`DELETE FROM pages_fts`);
  db.run(`
    INSERT INTO pages_fts (slug, label, title, description, content)
    SELECT slug, label, title, description, content FROM pages
  `);
}

function ensurePagesFts(db: any) {
  const ftsSql = getSingleValue(
    db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pages_fts'`
  );

  if (!ftsSql) {
    createPagesFts(db);
    rebuildPagesFts(db);
    return;
  }

  if (/content\s*=\s*["']pages["']/i.test(String(ftsSql))) {
    db.run(`DROP TABLE pages_fts`);
    createPagesFts(db);
    rebuildPagesFts(db);
  }
}

export function saveDb() {
  if (!_db) return;
  const data = _db.export();
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(DB_PATH, Buffer.from(data));
}

export async function getMeta(key: string): Promise<string | null> {
  const db = await openDb();
  const result = db.exec(`SELECT value FROM meta WHERE key = ?`, [key]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as string;
}

export async function setMeta(key: string, value: string) {
  const db = await openDb();
  db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
  saveDb();
}

export async function upsertPage(page: {
  slug: string;
  label: string;
  url: string;
  title: string;
  description: string;
  content: string;
  section: string;
}) {
  const db = await openDb();
  const now = Date.now();

  db.run(`BEGIN TRANSACTION`);
  try {
    db.run(
      `INSERT OR REPLACE INTO pages (slug, label, url, title, description, content, section, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [page.slug, page.label, page.url, page.title, page.description, page.content, page.section, now]
    );

    // Atualiza FTS
    db.run(`DELETE FROM pages_fts WHERE slug = ?`, [page.slug]);
    db.run(
      `INSERT INTO pages_fts (slug, label, title, description, content)
       VALUES (?, ?, ?, ?, ?)`,
      [page.slug, page.label, page.title, page.description, page.content]
    );
    db.run(`COMMIT`);
  } catch (err) {
    db.run(`ROLLBACK`);
    throw err;
  }
}

function rowsToObjects(result: any[]): any[] {
  if (result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map((row: any[]) =>
    Object.fromEntries(columns.map((col: string, i: number) => [col, row[i]]))
  );
}

function extractExcerpt(content: string, query: string, windowSize = 500): string {
  const normalizedQuery = query.toLowerCase().trim();
  const terms = normalizedQuery
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);

  const lower = content.toLowerCase();
  let bestPos = -1;

  if (normalizedQuery) {
    bestPos = lower.indexOf(normalizedQuery);
  }

  for (const term of terms) {
    const pos = lower.indexOf(term);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) {
      bestPos = pos;
    }
  }

  if (bestPos === -1) {
    return content.slice(0, windowSize).trim();
  }

  const start = Math.max(0, bestPos - 100);
  const end = Math.min(content.length, bestPos + windowSize);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function withExcerpts(rows: any[], query: string): any[] {
  return rows.map(({ content, rank, ...row }) => ({
    ...row,
    excerpt: extractExcerpt(String(content ?? ""), query),
  }));
}

type SearchCandidate = {
  slug: string;
  label: string;
  url: string;
  title: string;
  description: string;
  section: string;
  content: string;
};

const QUERY_SYNONYMS: Record<string, string[]> = {
  animation: ["animate", "transition"],
  animations: ["animation", "animate", "transition"],
  breakpoint: ["responsive", "screen", "media"],
  breakpoints: ["responsive", "screen", "media"],
  css: ["style", "styles"],
  custom: ["arbitrary", "theme"],
  dark: ["color-scheme", "prefers-color-scheme"],
  grid: ["columns", "rows"],
  responsive: ["breakpoint", "breakpoints", "screen", "screens", "media"],
  token: ["variable", "variables", "theme"],
  tokens: ["variable", "variables", "theme"],
  variables: ["variable", "tokens", "theme"],
};

const GENERIC_SLUGS = new Set([
  "adding-custom-styles",
  "colors",
  "styling-with-utility-classes",
  "theme",
]);

const QUERY_INTENT_BOOSTS: Array<{
  terms: string[];
  boosts: Record<string, number>;
}> = [
  {
    terms: ["dark", "mode"],
    boosts: {
      "dark-mode": 900,
      "color-scheme": 700,
    },
  },
  {
    terms: ["flex", "grid", "responsive"],
    boosts: {
      "responsive-design": 760,
      flex: 420,
      "grid-template-columns": 380,
      "grid-template-rows": 260,
    },
  },
  {
    terms: ["custom", "css"],
    boosts: {
      "adding-custom-styles": 850,
      theme: 180,
    },
  },
  {
    terms: ["theme", "tokens"],
    boosts: {
      theme: 520,
      "adding-custom-styles": 260,
    },
  },
  {
    terms: ["css", "variables"],
    boosts: {
      theme: 380,
      "adding-custom-styles": 360,
    },
  },
  {
    terms: ["animation"],
    boosts: {
      animation: 700,
      "transition-property": 100,
    },
  },
];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((term) => term.length >= 2);
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms)];
}

function expandTerms(terms: string[]): string[] {
  return uniqueTerms([
    ...terms,
    ...terms.flatMap((term) => QUERY_SYNONYMS[term] ?? []),
  ]);
}

function fieldIncludes(field: string, phrase: string): boolean {
  return phrase.length > 0 && field.includes(phrase);
}

function countFieldTermMatches(field: string, terms: string[]): number {
  let matches = 0;
  for (const term of terms) {
    if (field.includes(term)) matches++;
  }
  return matches;
}

function scoreSearchCandidate(candidate: SearchCandidate, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const originalTerms = uniqueTerms(tokenize(query));
  const expandedTerms = expandTerms(originalTerms);
  const slugPhrase = originalTerms.join("-");
  const queryTermSet = new Set(originalTerms);

  if (!normalizedQuery || originalTerms.length === 0) return 0;

  const slug = candidate.slug.toLowerCase();
  const slugText = normalizeSearchText(candidate.slug);
  const title = normalizeSearchText(candidate.title || candidate.label);
  const label = normalizeSearchText(candidate.label);
  const description = normalizeSearchText(candidate.description ?? "");
  const section = normalizeSearchText(candidate.section ?? "");
  const content = normalizeSearchText(candidate.content ?? "");

  let score = 0;

  if (slug === slugPhrase) score += 1600;
  if (title === normalizedQuery) score += 1400;
  if (slug.startsWith(`${slugPhrase}-`) || slug.startsWith(slugPhrase)) score += 850;
  if (fieldIncludes(title, normalizedQuery)) score += 750;
  if (fieldIncludes(label, normalizedQuery)) score += 650;
  if (fieldIncludes(description, normalizedQuery)) score += 240;
  if (fieldIncludes(content, normalizedQuery)) score += 120;

  const slugMatches = countFieldTermMatches(slugText, originalTerms);
  const titleMatches = countFieldTermMatches(title, originalTerms);
  const labelMatches = countFieldTermMatches(label, originalTerms);
  const descriptionMatches = countFieldTermMatches(description, originalTerms);
  const sectionMatches = countFieldTermMatches(section, originalTerms);
  const contentMatches = countFieldTermMatches(content, originalTerms);

  score += slugMatches * 180;
  score += titleMatches * 170;
  score += labelMatches * 110;
  score += descriptionMatches * 45;
  score += sectionMatches * 30;
  score += contentMatches * 8;

  const importantMatches = new Set<string>();
  for (const term of originalTerms) {
    if (
      slugText.includes(term) ||
      title.includes(term) ||
      label.includes(term) ||
      description.includes(term)
    ) {
      importantMatches.add(term);
    }
  }

  if (importantMatches.size === originalTerms.length) score += 500;
  else if (importantMatches.size >= Math.ceil(originalTerms.length / 2)) score += 180;

  const expandedOnlyTerms = expandedTerms.filter((term) => !originalTerms.includes(term));
  score += countFieldTermMatches(slugText, expandedOnlyTerms) * 45;
  score += countFieldTermMatches(title, expandedOnlyTerms) * 40;
  score += countFieldTermMatches(description, expandedOnlyTerms) * 15;
  score += countFieldTermMatches(content, expandedOnlyTerms) * 3;

  if (originalTerms.length > 1 && contentMatches === originalTerms.length) score += 50;
  if (GENERIC_SLUGS.has(slug) && importantMatches.size < originalTerms.length) score -= 120;

  for (const intent of QUERY_INTENT_BOOSTS) {
    if (intent.terms.every((term) => queryTermSet.has(term))) {
      score += intent.boosts[slug] ?? 0;
    }
  }

  return score;
}

function rankSearchCandidates(rows: SearchCandidate[], query: string, limit: number): any[] {
  return withExcerpts(
    rows
      .map((row) => ({
        ...row,
        rank: scoreSearchCandidate(row, query),
      }))
      .filter((row) => row.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.slug.localeCompare(b.slug))
      .slice(0, limit),
    query
  );
}

export async function searchPages(
  query: string,
  limit = 5
): Promise<any[]> {
  const db = await openDb();

  try {
    const result = db.exec(
      `SELECT slug, label, url, title, description, section, content
       FROM pages`
    );

    return rankSearchCandidates(rowsToObjects(result), query, limit);
  } catch {
    // Fallback: LIKE simples se FTS falhar (ex: query com caracteres especiais)
    const normalizedQuery = query.trim().toLowerCase();
    const slugQuery = normalizedQuery.replace(/\s+/g, "-");
    const result = db.exec(
      `SELECT slug, label, url, title, description, section, content
       FROM pages
       WHERE title LIKE ? OR content LIKE ? OR slug LIKE ?
       ORDER BY
         CASE
           WHEN lower(slug) = ? THEN 1
           WHEN lower(slug) LIKE ? THEN 2
           WHEN lower(title) LIKE ? THEN 3
           ELSE 4
         END,
         slug
       LIMIT ?`,
      [
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        slugQuery,
        `${slugQuery}%`,
        `${normalizedQuery}%`,
        limit,
      ]
    );
    return withExcerpts(rowsToObjects(result), query);
  }
}

export async function getPage(slug: string): Promise<any | null> {
  const db = await openDb();
  const result = db.exec(
    `SELECT * FROM pages WHERE slug = ?`,
    [slug]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  const { columns, values } = result[0];
  return Object.fromEntries(columns.map((col: string, i: number) => [col, values[0][i]]));
}

export async function getAllPages(): Promise<any[]> {
  const db = await openDb();
  const result = db.exec(
    `SELECT slug, label, url, title, section, fetched_at FROM pages ORDER BY section, slug`
  );
  if (result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map((row: any[]) =>
    Object.fromEntries(columns.map((col: string, i: number) => [col, row[i]]))
  );
}

export async function getPageCount(): Promise<number> {
  const db = await openDb();
  const result = db.exec(`SELECT COUNT(*) FROM pages`);
  return result[0]?.values[0][0] as number ?? 0;
}
