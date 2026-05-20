# Plano de Melhorias — tailwindcss-mcp v2

> Gerado após análise estática do código + testes funcionais em 20/05/2026.

---

## Sumário executivo

O servidor MCP funciona corretamente nos casos principais. Os cinco problemas abaixo degradam a **precisão das respostas** e a **performance** — nenhum deles quebra funcionalidades, mas todos têm impacto direto na qualidade para o consumidor do MCP.

| #   | Problema                                     | Arquivo(s)   | Impacto  | Esforço |
| --- | -------------------------------------------- | ------------ | -------- | ------- |
| 1   | Conteúdo duplicado nas páginas               | `crawler.ts` | 🔴 Alto  | Baixo   |
| 2   | Ranking FTS sem priorização por título/slug  | `db.ts`      | 🔴 Alto  | Médio   |
| 3   | Excerpt estático (sempre início do conteúdo) | `db.ts`      | 🟡 Médio | Baixo   |
| 4   | `saveDb()` chamado a cada `upsertPage`       | `db.ts`      | 🟡 Médio | Baixo   |
| 5   | `list_tailwind_pages` sem paginação          | `index.ts`   | 🟢 Baixo | Baixo   |

---

## Problema 1 — Conteúdo duplicado nas páginas

### Diagnóstico

**Arquivo:** `src/crawler.ts` · linhas 129–141

```ts
const rawContent =
  $("article").text() ||
  $('[class*="prose"]').text() || ...
```

O site do Tailwind CSS usa SSR com React. Cada exemplo de código aparece **duas vezes** no HTML:

- Uma vez no componente de preview visual (renderizado)
- Uma vez no bloco `<code>` / `<pre>` lado a lado

O `.text()` do Cheerio captura ambos sem distinção, gerando blocos duplicados no campo `content` armazenado no banco.

### Evidência do teste

Na resposta de `get_tailwind_doc_page("animation")`, todos os exemplos HTML apareceram duas vezes consecutivas.

### Solução proposta

Antes de chamar `.text()`, remover os elementos de preview que duplicam o conteúdo:

```ts
// Adicionar à lista de remoções em fetchPage()
$(
  "nav, header, footer, script, style, [data-algolia-exclude], " +
    ".sidebar, aside, [role=navigation], " +
    "[aria-hidden='true'], .not-prose, [data-rehype-pretty-code-fragment] ~ *",
).remove();

// Deduplicar linhas consecutivas idênticas
const lines = rawContent.split("\n");
const deduped = lines.filter((line, i) => line !== lines[i - 1]);
const content = deduped
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim()
  .slice(0, 10000);
```

---

## Problema 2 — Ranking FTS sem priorização por título/slug

### Diagnóstico

**Arquivo:** `src/db.ts` · função `searchPages` · linha ~52

```ts
const result = db.exec(
  `SELECT p.slug, p.label, p.url, p.title, p.description, p.section,
          substr(p.content, 1, 500) as excerpt
   FROM pages_fts
   JOIN pages p ON pages_fts.slug = p.slug
   WHERE pages_fts MATCH ?
   LIMIT ?`,
  [safeQuery, limit],
);
```

Não há `ORDER BY`. O FTS4 retorna resultados na **ordem interna do índice invertido**, que não corresponde à relevância semântica. Isso causa, por exemplo, `"dark mode"` não retornar `/docs/dark-mode` como primeiro resultado.

### Solução proposta

Usar uma query com ranking explícito via `UNION ALL`:

```ts
const result = db.exec(
  `
  WITH ranked AS (
    -- Prioridade 1: slug exato
    SELECT slug, label, url, title, description, section,
           substr(content, 1, 500) as excerpt, 1 as rank
    FROM pages WHERE slug = ?

    UNION ALL

    -- Prioridade 2: título começa com o termo
    SELECT slug, label, url, title, description, section,
           substr(content, 1, 500) as excerpt, 2 as rank
    FROM pages WHERE lower(title) LIKE lower(? || '%') AND slug != ?

    UNION ALL

    -- Prioridade 3: FTS full-text
    SELECT p.slug, p.label, p.url, p.title, p.description, p.section,
           substr(p.content, 1, 500) as excerpt, 3 as rank
    FROM pages_fts
    JOIN pages p ON pages_fts.slug = p.slug
    WHERE pages_fts MATCH ?
  )
  SELECT * FROM ranked
  GROUP BY slug
  ORDER BY rank, slug
  LIMIT ?
`,
  [safeQuery, safeQuery, safeQuery, safeQuery, limit],
);
```

> **Nota:** `GROUP BY slug` elimina duplicatas quando um resultado aparece em mais de uma categoria — mantendo a menor `rank`.

---

## Problema 3 — Excerpt estático

### Diagnóstico

**Arquivo:** `src/db.ts` · linha ~58

```ts
substr(p.content, 1, 500) as excerpt;
```

O excerpt sempre retorna os primeiros 500 caracteres do conteúdo, independentemente de onde o termo de busca aparece. Para páginas longas como `hover-focus-and-other-states`, o match real pode estar no meio ou no fim do documento.

### Solução proposta

Localizar a primeira ocorrência do termo no conteúdo e retornar uma janela ao redor:

```ts
// Em db.ts: nova função helper
function extractExcerpt(
  content: string,
  query: string,
  windowSize = 300,
): string {
  const lower = content.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/);

  let bestPos = -1;
  for (const term of terms) {
    const pos = lower.indexOf(term);
    if (pos !== -1 && (bestPos === -1 || pos < bestPos)) bestPos = pos;
  }

  if (bestPos === -1) return content.slice(0, windowSize);

  const start = Math.max(0, bestPos - 80);
  const end = Math.min(content.length, bestPos + windowSize);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end) + suffix;
}
```

---

## Problema 4 — `saveDb()` chamado a cada `upsertPage`

### Diagnóstico

**Arquivo:** `src/db.ts` · função `upsertPage` · última linha

```ts
export async function upsertPage(page: {...}) {
  // ...insert + FTS update...
  saveDb(); // ← chamado 198 vezes durante um crawl completo
}
```

`saveDb()` serializa o banco inteiro (`_db.export()`) e escreve no disco a cada página processada. Para 198 páginas, isso gera **198 writes do arquivo completo** (que cresce proporcionalmente ao conteúdo). O crawl demora mais que o necessário.

### Solução proposta

Remover `saveDb()` de `upsertPage` e chamar apenas quando necessário:

```ts
// src/db.ts — upsertPage: remover saveDb() do final

// src/crawler.ts — crawlAll: adicionar saveDb() ao final
import { saveDb } from "./db.js";

export async function crawlAll(opts) {
  // ... lógica existente ...

  await setMeta("last_crawled_at", String(Date.now()));
  await setMeta("last_checked_at", String(Date.now()));
  saveDb(); // ← único save ao final do crawl
}
```

Para `upsertPage` chamado individualmente (fora do crawl), o chamador pode invocar `saveDb()` explicitamente. Alternativamente, usar um mecanismo de **debounce** com 2s de delay:

```ts
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDb();
    saveTimer = null;
  }, 2000);
}
```

---

## Problema 5 — `list_tailwind_pages` sem paginação

### Diagnóstico

**Arquivo:** `src/index.ts` · tool `list_tailwind_pages`

Com 198 páginas, a resposta retorna um bloco de texto muito grande para contextos com limite de tokens. Sem paginação, um agente de IA pode ter dificuldade em processar a saída.

### Solução proposta

Adicionar parâmetros opcionais `limit` e `offset`:

```ts
server.tool(
  "list_tailwind_pages",
  "...",
  {
    section: z.string().optional(),
    limit: z.number().min(1).max(50).optional().default(50),
    offset: z.number().min(0).optional().default(0),
  },
  async ({ section, limit, offset }) => {
    // ...filtro existente...
    const paginated = filtered.slice(offset, offset + limit);
    const hasMore = offset + limit < filtered.length;

    // Adicionar ao rodapé:
    const footer = hasMore
      ? `\n\n*Mostrando ${offset + 1}–${offset + paginated.length} de ${filtered.length}. Use offset=${offset + limit} para ver mais.*`
      : `\n\n*Total: ${filtered.length} página(s).*`;
  },
);
```

---

## Ordem de implementação recomendada

```
1. Problema 4 (saveDb)       → quick win, sem risco, melhora crawl imediatamente
2. Problema 1 (duplicação)   → maior impacto na qualidade das respostas
3. Problema 2 (ranking FTS)  → maior impacto na precisão das buscas
4. Problema 3 (excerpt)      → melhora UX de forma incremental
5. Problema 5 (paginação)    → baixa urgência, mas bom para escalabilidade
```
