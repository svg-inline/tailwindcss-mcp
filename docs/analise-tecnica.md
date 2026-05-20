# Análise Técnica do Código — tailwindcss-mcp v2

> Mapeamento detalhado da arquitetura, dependências e pontos de atenção por arquivo.

---

## Visão geral da arquitetura

```
src/
├── index.ts       → Servidor MCP: define as 5 tools, gerencia revalidação lazy
├── crawler.ts     → Busca páginas no GitHub/web, infere seções, faz crawl
├── db.ts          → Camada de acesso ao SQLite (sql.js), FTS4, save em disco
├── cli-crawl.ts   → CLI standalone para crawl manual (npm run crawl)
└── urls.json      → Lista de URLs da documentação do Tailwind CSS
```

---

## src/index.ts

### Responsabilidades

- Inicializa o `McpServer` via SDK `@modelcontextprotocol/sdk`
- Registra as 5 tools: `search_tailwind_docs`, `get_tailwind_doc_page`, `list_tailwind_pages`, `get_tailwind_cache_status`, `force_revalidate_tailwind_cache`
- Gerencia revalidação em background com `ensureRevalidated()`

### Padrão de revalidação lazy

```ts
let revalidationPromise: Promise<any> | null = null;
function ensureRevalidated() {
  if (!revalidationPromise) {
    revalidationPromise = revalidateIfNeeded().catch(...);
  }
  return revalidationPromise;
}
```

**Ponto positivo:** evita múltiplas revalidações paralelas.
**Ponto de atenção:** o resultado da Promise é descartado — se `revalidateIfNeeded` retornar `"revalidated"`, o servidor não emite nenhum sinal para o cliente.

### Tools registradas

| Tool                              | Valida DB vazio | Trata erro         | Usa `isError` |
| --------------------------------- | --------------- | ------------------ | ------------- |
| `search_tailwind_docs`            | ✅              | ✅ (fallback LIKE) | ❌            |
| `get_tailwind_doc_page`           | ❌              | ✅                 | ✅            |
| `list_tailwind_pages`             | ✅              | ✅                 | ❌            |
| `get_tailwind_cache_status`       | ✅              | ❌                 | ❌            |
| `force_revalidate_tailwind_cache` | ❌              | ❌                 | ❌            |

---

## src/db.ts

### Responsabilidades

- Abre/cria o banco SQLite via `sql.js` (WebAssembly, sem binários nativos)
- Gerencia schema: tabela `pages`, tabela `meta`, índice FTS4 `pages_fts`
- Expõe: `upsertPage`, `searchPages`, `getPage`, `getAllPages`, `getPageCount`, `getMeta`, `setMeta`, `saveDb`

### Modelo de dados

```sql
-- Tabela principal
pages (
  slug        TEXT PRIMARY KEY,  -- ex: "animation", "dark-mode"
  label       TEXT,              -- nome legível da URL
  url         TEXT,
  title       TEXT,              -- <h1> da página
  description TEXT,              -- meta description
  content     TEXT,              -- texto extraído (até 10.000 chars)
  section     TEXT,              -- inferida em crawler.ts
  fetched_at  INTEGER            -- timestamp Unix
)

-- Índice de busca full-text
pages_fts USING fts4(slug, label, title, description, content)
```

### Observações técnicas

1. **Singleton global `_db`**: o banco vive em memória. O arquivo em disco é a fonte de persistência e é carregado uma vez no startup.
2. **`saveDb()` escreve o buffer inteiro**: `_db.export()` serializa tudo. Arquivos grandes (>5MB) vão aumentar o tempo de crawl linearmente.
3. **Transações em `upsertPage`**: uso correto de `BEGIN/COMMIT/ROLLBACK` — padrão seguro.
4. **Fallback LIKE em `searchPages`**: protege contra queries com caracteres especiais no FTS4. Captura silenciosamente o erro, o que pode esconder bugs de FTS.
5. **`ensurePagesFts` na inicialização**: migra automaticamente o schema do FTS se detectar o formato antigo (`content="pages"`). Boa prática de migração non-destructive.

---

## src/crawler.ts

### Responsabilidades

- Carrega e deduplica URLs do `src/urls.json`
- Faz fetch HTTP de cada página com Axios
- Extrai título, descrição e conteúdo textual com Cheerio
- Infere a seção com `inferSection()` via mapeamento de RegExp
- Verifica SHA do último commit no GitHub para revalidação

### Pipeline de extração por página

```
HTTP GET → cheerio.load() → remove nav/footer/etc → .text() → normaliza espaços → slice(0, 10000)
```

### Função `inferSection`

Mapeia label/slug para seção via array de pares `[RegExp, string]`. Cobre ~18 seções do Tailwind CSS v4. Páginas não mapeadas caem em `"Other"`.

**Risco:** regex case-insensitive sem delimitadores pode gerar falsos positivos. Ex.: o padrão `/width|height|.../i` casaria com qualquer slug que contivesse essas palavras em contextos inesperados.

### Função `getLatestCommitSha`

```ts
const res = await axios.get(GITHUB_API, {
  params: { path: "src/docs", per_page: 1 },
  headers: { "User-Agent": "tailwindcss-mcp/1.0" },
  timeout: 8000,
});
```

Usa a API pública do GitHub sem autenticação. Sujeito ao limite de **60 req/hora por IP**. Para uso em produção ou CI, adicionar `Authorization: Bearer <token>` via variável de ambiente.

### Função `revalidateIfNeeded`

Verifica o `last_checked_at` em meta. Se passou menos de 1 hora desde o último check, retorna `"fresh"` sem fazer request ao GitHub. Estratégia de **TTL de 1 hora** — razoável para documentação que não muda com frequência.

---

## src/cli-crawl.ts

CLI simples para uso local. Exibe barra de progresso no stdout e logs de status. Bem implementado para sua finalidade.

**Atenção:** usa `process.stdout.write` com `\r` para overwrite da linha — não funciona em terminais sem suporte a ANSI (ex.: alguns ambientes CI/CD).

---

## Dependências

| Pacote                      | Versão  | Uso                                |
| --------------------------- | ------- | ---------------------------------- |
| `@modelcontextprotocol/sdk` | ^1.29.0 | Framework MCP                      |
| `axios`                     | ^1.16.1 | HTTP requests (crawl + GitHub API) |
| `cheerio`                   | ^1.2.0  | Parse HTML das páginas do Tailwind |
| `sql.js`                    | ^1.12.0 | SQLite via WebAssembly             |
| `zod`                       | ^4.4.3  | Validação dos parâmetros das tools |

### Por que `sql.js` e não `better-sqlite3`?

`sql.js` compila o SQLite para WebAssembly, eliminando dependências nativas e tornando o pacote portável entre plataformas sem recompilar. A desvantagem é performance inferior para writes intensos — irrelevante no contexto de uso atual (leitura-dominante após o crawl).

---

## Ausências identificadas

| Item                                   | Status     | Observação                                                              |
| -------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Testes unitários                       | ❌ Ausente | Sem Jest/Vitest. Funções de db e crawler são testáveis de forma isolada |
| Testes de integração                   | ❌ Ausente | Sem mock do servidor MCP                                                |
| Variável de ambiente para GitHub token | ❌ Ausente | Rate limit de 60 req/h sem auth                                         |
| `.env` / `dotenv`                      | ❌ Ausente | Configurações hardcoded (`CHECK_INTERVAL_MS`, `concurrency`)            |
| Logging estruturado                    | ❌ Ausente | Usa `console.error` diretamente                                         |
| Healthcheck da tool                    | ❌ Ausente | Nenhuma tool verifica conectividade                                     |
