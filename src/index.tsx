import { Hono } from 'hono'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
}

type Entry = {
  id: string
  url: string
  note: string
  hostname: string
  createdAt: string
  tags: string[]
}

const RECENT_LIMIT = 100
const memoryStore: Entry[] = []

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

const normalizeUrl = (rawUrl: string) => {
  const normalized = new URL(rawUrl.trim())
  return normalized.toString()
}

const parseTags = (raw: unknown) => {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === 'string' ? item : ''))
      .join(',')
  }
  if (typeof raw === 'string') {
    return raw
  }
  return ''
}

const normalizeTags = (raw: string) => {
  if (!raw) return []
  const tags = raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  return tags.slice(0, 5)
}

const validateTags = (raw: string) => {
  const tags = normalizeTags(raw)
  if (tags.some((tag) => tag.length > 20)) {
    return { ok: false, error: 'タグは1つ20文字以内で入力してください。' } as const
  }
  return { ok: true, tags } as const
}

const validateInput = (urlInput: unknown, noteInput: unknown, tagsInput: unknown) => {
  if (typeof urlInput !== 'string' || urlInput.trim().length === 0) {
    return { ok: false, error: 'URLを入力してください。' } as const
  }
  if (typeof noteInput !== 'string' || noteInput.trim().length === 0) {
    return { ok: false, error: 'メモを入力してください。' } as const
  }

  try {
    normalizeUrl(urlInput)
  } catch {
    return { ok: false, error: '正しいURL形式で入力してください。' } as const
  }

  if (noteInput.trim().length > 500) {
    return { ok: false, error: 'メモは500文字以内で入力してください。' } as const
  }

  const tagsResult = validateTags(parseTags(tagsInput))
  if (!tagsResult.ok) {
    return { ok: false, error: tagsResult.error } as const
  }

  return {
    ok: true,
    data: {
      url: urlInput.trim(),
      note: noteInput.trim(),
      tags: tagsResult.tags,
    },
  } as const
}

const sanitizeQuery = (query?: string | null) => {
  if (!query) return undefined
  const trimmed = query.trim().slice(0, 200)
  return trimmed.length > 0 ? trimmed : undefined
}

const filterEntries = (entries: Entry[], query?: string) => {
  if (!query) return entries.slice()
  const lower = query.toLowerCase()
  return entries.filter((entry) => {
    return (
      entry.url.toLowerCase().includes(lower) ||
      entry.note.toLowerCase().includes(lower) ||
      entry.hostname.toLowerCase().includes(lower) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(lower))
    )
  })
}

const mapRowToEntry = (row: Record<string, unknown>): Entry => {
  const rawTags = typeof row.tags === 'string' ? row.tags : '[]'
  let tags: string[] = []
  try {
    tags = JSON.parse(rawTags)
  } catch {
    tags = []
  }
  return {
    id: String(row.id),
    url: String(row.url),
    note: String(row.note ?? ''),
    hostname: String(row.hostname ?? ''),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    tags,
  }
}

const buildSearchWhere = (query?: string) => {
  if (!query) {
    return { clause: '', params: [] as string[] }
  }
  const like = `%${query}%`
  const clause = 'WHERE url LIKE ? OR note LIKE ? OR hostname LIKE ? OR tags LIKE ?'
  const params = [like, like, like, like]
  return { clause, params }
}

const getEntries = async (db: D1Database | undefined, query?: string) => {
  const { clause, params } = buildSearchWhere(query)
  if (!db) {
    return filterEntries(memoryStore, query).slice(0, RECENT_LIMIT)
  }
  try {
    const stmt = db
      .prepare(
        `
        SELECT id, url, note, hostname, tags, created_at
        FROM entries
        ${clause}
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `
      )
      .bind(...params, RECENT_LIMIT)

    const { results } = await stmt.all<Record<string, unknown>>()
    return results.map(mapRowToEntry)
  } catch (error) {
    console.error('getEntries failed', error)
    return filterEntries(memoryStore, query).slice(0, RECENT_LIMIT)
  }
}

const getTotalCount = async (db: D1Database | undefined) => {
  if (!db) return memoryStore.length
  try {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM entries').first<{ count: number }>()
    return row?.count ?? 0
  } catch (error) {
    console.error('getTotalCount failed', error)
    return memoryStore.length
  }
}

const pushMemoryEntry = (entry: Entry) => {
  memoryStore.unshift(entry)
  if (memoryStore.length > RECENT_LIMIT) {
    memoryStore.pop()
  }
}

const insertEntry = async (db: D1Database | undefined, url: string, note: string, tags: string[]) => {
  const normalizedUrl = normalizeUrl(url)
  const hostname = new URL(normalizedUrl).hostname
  const entry: Entry = {
    id: crypto.randomUUID(),
    url: normalizedUrl,
    note,
    hostname,
    createdAt: new Date().toISOString(),
    tags,
  }

  if (!db) {
    pushMemoryEntry(entry)
    return entry
  }

  try {
    await db
      .prepare(
        `
        INSERT INTO entries (id, url, note, hostname, tags, created_at, synced_to_notion)
        VALUES (?, ?, ?, ?, ?, ?, 0)
      `
      )
      .bind(entry.id, entry.url, entry.note, entry.hostname, JSON.stringify(entry.tags), entry.createdAt)
      .run()
  } catch (error) {
    console.error('insertEntry failed', error)
    pushMemoryEntry(entry)
    return entry
  }

  return entry
}

const Home = ({
  entries,
  totalCount,
  error,
  submitted,
  defaults,
  query,
  showModal,
}: {
  entries: Entry[]
  error?: string
  submitted?: boolean
  defaults?: {
    url?: string
    note?: string
    tags?: string
  }
  query?: string
  totalCount: number
  showModal?: boolean
}) => (
  <>
    <header class="hero">
      <div class="hero__inner">
        <p class="badge">Guest Mode</p>
        <h1>ReferenceHub</h1>
        <p class="tagline">
          気になったURLとメモをすぐに残して、みんなと共有しよう。ログインなしでサクッと投稿できます。
        </p>
      </div>
    </header>
    <main>
      <section class="panel search-panel">
        <div class="panel__header">
          <h2>みんなのリファレンスを検索</h2>
          <button type="button" class="ghost-btn" data-open-modal>
            + 投稿する
          </button>
        </div>
        {error && <p class="alert alert--error">{error}</p>}
        {submitted && !error && <p class="alert alert--success">投稿が完了しました！</p>}
        <form method="get" action="/" class="search-form">
          <input
            type="search"
            name="q"
            placeholder="URL、メモ、タグで検索"
            value={query ?? ''}
            aria-label="投稿を検索"
          />
          <button type="submit">検索</button>
        </form>
        <p class="search-summary">
          {query
            ? `「${query}」に一致する投稿 ${entries.length}件 / 全${totalCount}件`
            : `全${totalCount}件の投稿から検索できます`}
        </p>
      </section>

      <section class="panel">
        <div class="panel__header">
          <h2>みんなの投稿</h2>
          {!query && <span class="count">{entries.length}件</span>}
        </div>
        {entries.length === 0 ? (
          <p class="empty">
            {query ? '検索条件に一致する投稿がありません。' : 'まだ投稿がありません。気になるURLを最初に残してみましょう！'}
          </p>
        ) : (
          <ul class="entry-list">
            {entries.map((entry) => (
              <li class="entry" key={entry.id}>
                <div class="entry__meta">
                  <span class="entry__host">{entry.hostname}</span>
                  <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString('ja-JP')}</time>
                </div>
                <a class="entry__link" href={entry.url} target="_blank" rel="noopener noreferrer">
                  {entry.url}
                </a>
                <p class="entry__note">{entry.note}</p>
                {entry.tags.length > 0 && (
                  <ul class="tag-list">
                    {entry.tags.map((tag) => (
                      <li class="tag" key={`${entry.id}-${tag}`}>
                        #{tag}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
    <dialog
      id="entry-modal"
      class="modal"
      data-force-open={showModal ? 'true' : undefined}
      {...(showModal ? { open: true } : {})}
    >
      <div class="modal__surface">
        <div class="modal__header">
          <h3>URLを投稿</h3>
          <button type="button" class="ghost-btn" data-close-modal>
            ×
          </button>
        </div>
        <form method="post" action="/entries" class="archive-form">
          <label>
            URL
            <input
              type="url"
              name="url"
              placeholder="https://example.com/article"
              required
              value={defaults?.url ?? ''}
            />
          </label>
          <label>
            メモ
            <textarea name="note" rows={3} placeholder="どんな内容かメモを残しましょう。" required>{defaults?.note ?? ''}</textarea>
          </label>
          <label>
            タグ（カンマ区切りで最大5件）
            <input type="text" name="tags" placeholder="design, inspiration" value={defaults?.tags ?? ''} />
          </label>
          <div class="modal__actions">
            <button type="button" class="ghost-btn" data-close-modal>
              キャンセル
            </button>
            <button type="submit">投稿する</button>
          </div>
        </form>
      </div>
    </dialog>
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){function init(){if(typeof window==="undefined"||typeof document==="undefined")return;if(typeof HTMLDialogElement==="undefined")return;var modal=document.getElementById("entry-modal");if(!modal||!(modal instanceof HTMLDialogElement))return;var openButtons=document.querySelectorAll("[data-open-modal]");var closeButtons=document.querySelectorAll("[data-close-modal]");function openModal(event){if(event&&event.preventDefault)event.preventDefault();modal.showModal()}function closeModal(event){if(event&&event.preventDefault)event.preventDefault();modal.close()}openButtons.forEach(function(button){button.addEventListener("click",openModal)});closeButtons.forEach(function(button){button.addEventListener("click",closeModal)});modal.addEventListener("click",function(event){if(event.target===modal){modal.close()}});document.addEventListener("keydown",function(event){if(event.key==="Escape"&&modal.open){modal.close()}});if(modal.dataset.forceOpen==="true"){modal.showModal();delete modal.dataset.forceOpen}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",init,{once:true})}else{init()}})();`,
      }}
    />
  </>
)

app.get('/', async (c) => {
  const submitted = c.req.query('submitted') === '1'
  const query = sanitizeQuery(c.req.query('q'))
  const db = c.env.DB

  const [entries, totalCount] = await Promise.all([getEntries(db, query), getTotalCount(db)])

  return c.render(<Home entries={entries} totalCount={totalCount} submitted={submitted} query={query} />)
})

app.post('/entries', async (c) => {
  const formData = await c.req.parseBody()
  const result = validateInput(formData.url, formData.note, formData.tags)

  if (!result.ok) {
    const db = c.env.DB
    const [entries, total] = await Promise.all([getEntries(db), getTotalCount(db)])
    return c.render(
      <Home
        entries={entries}
        totalCount={total}
        error={result.error}
        defaults={{
          url: typeof formData.url === 'string' ? formData.url : '',
          note: typeof formData.note === 'string' ? formData.note : '',
          tags: typeof formData.tags === 'string' ? formData.tags : '',
        }}
        showModal
      />,
      400
    )
  }

  try {
    await insertEntry(c.env.DB, result.data.url, result.data.note, result.data.tags)
  } catch (error) {
    console.error('Failed to insert entry', error)
    const db = c.env.DB
    const [entries, total] = await Promise.all([getEntries(db), getTotalCount(db)])
    return c.render(
      <Home
        entries={entries}
        totalCount={total}
        error="投稿の保存中に問題が発生しました。しばらくしてから再度お試しください。"
        defaults={{
          url: typeof formData.url === 'string' ? formData.url : '',
          note: typeof formData.note === 'string' ? formData.note : '',
          tags: typeof formData.tags === 'string' ? formData.tags : '',
        }}
        showModal
      />,
      500
    )
  }

  return c.redirect('/?submitted=1#entries', 303)
})

app.get('/api/entries', async (c) => {
  const query = sanitizeQuery(c.req.query('q'))
  const [entries, total] = await Promise.all([getEntries(c.env.DB, query), getTotalCount(c.env.DB)])
  return c.json({ total, count: entries.length, entries })
})

app.post('/api/entries', async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'JSONを解析できませんでした。' }, 400)
  }

  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const result = validateInput(record.url, record.note, record.tags)

  if (!result.ok) {
    return c.json({ error: result.error }, 400)
  }

  try {
    const entry = await insertEntry(c.env.DB, result.data.url, result.data.note, result.data.tags)
    return c.json(entry, 201)
  } catch (error) {
    console.error('Failed to insert entry via API', error)
    return c.json({ error: '保存に失敗しました。' }, 500)
  }
})

export default app
