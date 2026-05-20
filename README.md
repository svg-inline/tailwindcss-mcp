# tailwindcss-mcp v2

Servidor MCP para consultar a documentação oficial do **Tailwind CSS v4** a partir de um cache local em SQLite.

Ele foi pensado para agentes de IA que precisam responder dúvidas sobre Tailwind com baixa latência, sem depender de acessar a internet a cada pergunta e com resultados mais relevantes do que uma busca textual simples.

---

## O que este MCP faz

- Mantém um cache local da documentação do Tailwind CSS em `data/tailwind.db`.
- Faz crawl das páginas oficiais em `https://tailwindcss.com/docs/*`.
- Indexa slug, título, descrição, seção e conteúdo textual de cada página.
- Revalida o cache usando o SHA do último commit da documentação no GitHub.
- Expõe tools MCP para buscar, listar, ler páginas e verificar o status do cache.
- Usa um ranker híbrido para melhorar a ordem dos resultados em buscas simples e compostas.

No cache atual, o crawler indexa **198 páginas** únicas da documentação.

---

## Como funciona

```text
1. npm run crawl
   -> carrega src/urls.json
   -> filtra URLs /docs/
   -> baixa cada página oficial
   -> extrai título, descrição e conteúdo limpo
   -> remove blocos duplicados/irrelevantes do HTML
   -> salva tudo em data/tailwind.db

2. Servidor MCP inicia
   -> abre o SQLite local via sql.js
   -> checa se precisa revalidar o cache
   -> consulta o GitHub no máximo 1 vez por hora

3. Agente chama uma tool
   -> busca roda no banco local
   -> resultados são pontuados por um ranker TypeScript
   -> resposta volta com título, seção, URL e excerpt contextual
```

O banco é lido localmente durante o uso normal. A rede só é necessária para o crawl ou para a verificação periódica de SHA.

---

## Busca e ranking

A busca não depende só da ordem interna do FTS. O MCP usa uma estratégia híbrida:

1. O conteúdo fica indexado em SQLite/FTS4.
2. O código calcula uma pontuação própria para cada página.
3. A ordenação final considera:
   - slug exato;
   - título exato ou começando pelo termo;
   - frase completa no título, descrição ou conteúdo;
   - quantidade de termos encontrados em slug/título/descrição/conteúdo;
   - sequências contíguas dos termos da query em slug/título;
   - sinônimos de domínio;
   - intenções conhecidas de Tailwind.

Exemplos de melhorias esperadas:

| Query                               | Resultado esperado                                   |
| ----------------------------------- | ---------------------------------------------------- |
| `animation`                         | `animation` em primeiro                              |
| `dark mode`                         | `dark-mode` em primeiro                              |
| `flex grid responsive`              | `responsive-design`, `grid-template-columns`, `flex` |
| `custom CSS variables theme tokens` | `adding-custom-styles`, `theme`                      |

Também há sugestão de slugs similares para `get_tailwind_doc_page`, usando tokens e distância de Levenshtein com score mínimo. Em entradas com vários tokens, a sugestão precisa ter pelo menos dois tokens compatíveis ou similaridade alta, evitando sugestões ruins baseadas em uma única letra ou palavra solta.

---

## Instalação

```bash
npm install
npm run build
npm run crawl
```

O comando `npm run crawl` popula o cache inicial. Em uma conexão normal, ele deve indexar as 198 páginas em menos de alguns minutos.

---

## Configuração no cliente MCP

Use sempre o arquivo compilado em `dist/index.js`.

### VS Code / MCP JSON

Exemplo para `mcp.json` no Windows:

```json
{
  "servers": {
    "tailwindcss": {
      "command": "node",
      "args": [
        "C:\\Users\\<my-user>\\Downloads\\tailwindcss-mcp-v2\\tailwindcss-mcp\\dist\\index.js"
      ]
    }
  }
}
```

Se o seu cliente usa o formato `mcpServers`, use:

```json
{
  "mcpServers": {
    "tailwindcss": {
      "command": "node",
      "args": [
        "C:\\Users\\<my-user>\\Downloads\\tailwindcss-mcp-v2\\tailwindcss-mcp\\dist\\index.js"
      ]
    }
  }
}
```

### Claude Desktop

Windows:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

macOS:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Configuração:

```json
{
  "mcpServers": {
    "tailwindcss": {
      "command": "node",
      "args": ["/caminho/absoluto/para/tailwindcss-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add tailwindcss -- node /caminho/absoluto/para/tailwindcss-mcp/dist/index.js
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tailwindcss": {
      "command": "node",
      "args": ["/caminho/absoluto/para/tailwindcss-mcp/dist/index.js"]
    }
  }
}
```

---

## Tools disponíveis

### `search_tailwind_docs`

Busca na documentação cacheada.

Entrada:

```json
{
  "query": "dark mode",
  "limit": 3
}
```

Retorna resultados com título, seção, URL, descrição e excerpt contextual.

### `get_tailwind_doc_page`

Retorna o conteúdo completo de uma página pelo slug.

Entrada:

```json
{
  "slug": "animation"
}
```

Se o slug não existir, tenta sugerir páginas similares com base em similaridade real.

### `list_tailwind_pages`

Lista páginas do cache, agrupadas por seção.

Entrada:

```json
{
  "section": "Typography",
  "limit": 5,
  "offset": 0
}
```

Parâmetros:

- `section`: filtro opcional por seção.
- `limit`: quantidade máxima de páginas, de 1 a 50. Padrão: 50.
- `offset`: deslocamento para paginação. Padrão: 0.

### `get_tailwind_cache_status`

Mostra:

- quantidade de páginas no cache;
- total de URLs conhecidas;
- data do último crawl;
- data da última verificação;
- SHA salvo da documentação.

### `force_revalidate_tailwind_cache`

Força uma verificação imediata do SHA no GitHub e recrawla se houver atualização ou se o cache estiver vazio.

---

## Scripts

```bash
npm run build        # Compila TypeScript para dist/
npm run crawl        # Refaz o crawl completo das páginas
npm run crawl:check  # Verifica SHA remoto vs. SHA em cache
npm run dev          # Inicia o servidor via tsx em src/index.ts
npm start            # Inicia o servidor compilado em dist/index.js
```

---

## Recriar o banco do zero

Windows PowerShell:

```powershell
Remove-Item -LiteralPath data\tailwind.db -Force
npm run crawl
```

macOS/Linux:

```bash
rm data/tailwind.db
npm run crawl
```

---

## Estrutura do projeto

```text
src/
  index.ts       # Servidor MCP e definição das tools
  crawler.ts     # Crawl, extração de conteúdo, seções e revalidação por SHA
  db.ts          # SQLite/sql.js, schema, busca, excerpts e ranker
  cli-crawl.ts   # CLI para crawl manual
  urls.json      # Lista de URLs da documentação

data/
  tailwind.db    # Banco SQLite local gerado pelo crawler

docs/
  analise-tecnica.md
  PLANO_MELHORIAS.md
```

---

## Estrutura do banco

```sql
meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)

pages (
  slug        TEXT PRIMARY KEY,
  label       TEXT,
  url         TEXT,
  title       TEXT,
  description TEXT,
  content     TEXT,
  section     TEXT,
  fetched_at  INTEGER
)

pages_fts USING fts4 (
  slug,
  label,
  title,
  description,
  content
)
```

Metadados usados:

- `last_commit_sha`: SHA do último commit da documentação cacheada.
- `last_crawled_at`: timestamp do último crawl completo.
- `last_checked_at`: timestamp da última verificação no GitHub.

---

## Notas técnicas

- O banco usa `sql.js`, então não depende de binários nativos como `better-sqlite3`.
- O crawler grava o banco uma vez ao final do crawl, evitando escrita completa a cada página.
- O conteúdo extraído remove navegação, header/footer, blocos escondidos e previews que duplicam exemplos.
- Os excerpts de busca são montados ao redor do termo encontrado, não apenas nos primeiros caracteres da página.
- A revalidação consulta a API pública do GitHub. Sem token, ela está sujeita ao rate limit público do GitHub.

---

## Licença

MIT
