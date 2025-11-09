import { Hono } from 'hono'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
}

type Entry = {
  id: string
  url: string
  note?: string
  context: string
  slideUrl?: string
  hostname: string
  createdAt: string
  tags: string[]
  tweetEmbedHtml?: string
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

const validateInput = (
  urlInput: unknown,
  noteInput: unknown,
  contextInput: unknown,
  slideUrlInput: unknown,
  tagsInput: unknown
) => {
  if (typeof urlInput !== 'string' || urlInput.trim().length === 0) {
    return { ok: false, error: 'URLを入力してください。' } as const
  }

  try {
    normalizeUrl(urlInput)
  } catch {
    return { ok: false, error: '正しいURL形式で入力してください。' } as const
  }

  const noteValue = typeof noteInput === 'string' ? noteInput.trim() : ''
  if (noteValue.length > 500) {
    return { ok: false, error: 'メモは500文字以内で入力してください。' } as const
  }

  if (typeof contextInput !== 'string' || contextInput.trim().length === 0) {
    return { ok: false, error: 'どんな文脈で利用したかを入力してください。' } as const
  }

  const contextValue = contextInput.trim()
  if (contextValue.length > 500) {
    return { ok: false, error: '文脈コメントは500文字以内で入力してください。' } as const
  }

  let slideUrlValue: string | undefined
  if (typeof slideUrlInput === 'string' && slideUrlInput.trim().length > 0) {
    try {
      slideUrlValue = normalizeUrl(slideUrlInput)
    } catch {
      return { ok: false, error: 'スライドURLが正しい形式ではありません。' } as const
    }
  }

  const tagsResult = validateTags(parseTags(tagsInput))
  if (!tagsResult.ok) {
    return { ok: false, error: tagsResult.error } as const
  }

  return {
    ok: true,
    data: {
      url: urlInput.trim(),
      note: noteValue.length > 0 ? noteValue : undefined,
      context: contextValue,
      slideUrl: slideUrlValue,
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
      (entry.note ?? '').toLowerCase().includes(lower) ||
      entry.context.toLowerCase().includes(lower) ||
      entry.hostname.toLowerCase().includes(lower) ||
      (entry.slideUrl ?? '').toLowerCase().includes(lower) ||
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
    note: row.note ? String(row.note) : undefined,
    context: String(row.context ?? ''),
    slideUrl: row.slide_url ? String(row.slide_url) : undefined,
    hostname: String(row.hostname ?? ''),
    createdAt: String(row.created_at ?? new Date().toISOString()),
    tags,
    tweetEmbedHtml: row.tweet_embed_html ? String(row.tweet_embed_html) : undefined,
  }
}

const buildSearchWhere = (query?: string) => {
  if (!query) {
    return { clause: '', params: [] as string[] }
  }
  const like = `%${query}%`
  const clause = 'WHERE url LIKE ? OR IFNULL(note, "") LIKE ? OR context LIKE ? OR hostname LIKE ? OR tags LIKE ? OR IFNULL(slide_url, "") LIKE ?'
  const params = [like, like, like, like, like, like]
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
        SELECT id, url, note, context, slide_url, hostname, tags, created_at, tweet_embed_html
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

const fetchTweetEmbed = async (url: string): Promise<string | undefined> => {
  const isTwitterUrl = /^https?:\/\/(twitter\.com|x\.com)\/\w+\/status\/\d+/.test(url)
  if (!isTwitterUrl) return undefined

  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&maxwidth=500`
    const response = await fetch(oembedUrl)
    if (!response.ok) return undefined

    const data = await response.json() as { html?: string }
    return data.html
  } catch (error) {
    console.error('Failed to fetch tweet embed', error)
    return undefined
  }
}

const insertEntry = async (
  db: D1Database | undefined,
  url: string,
  note: string | undefined,
  context: string,
  slideUrl: string | undefined,
  tags: string[]
) => {
  const normalizedUrl = normalizeUrl(url)
  const hostname = new URL(normalizedUrl).hostname

  // Fetch tweet embed if it's a Twitter/X URL
  const tweetEmbedHtml = await fetchTweetEmbed(normalizedUrl)

  const entry: Entry = {
    id: crypto.randomUUID(),
    url: normalizedUrl,
    note,
    context,
    slideUrl,
    hostname,
    createdAt: new Date().toISOString(),
    tags,
    tweetEmbedHtml,
  }

  if (!db) {
    pushMemoryEntry(entry)
    return entry
  }

  try {
    await db
      .prepare(
        `
        INSERT INTO entries (id, url, note, context, slide_url, hostname, tags, created_at, synced_to_notion, tweet_embed_html)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `
      )
      .bind(
        entry.id,
        entry.url,
        entry.note ?? '',
        entry.context,
        entry.slideUrl ?? null,
        entry.hostname,
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.tweetEmbedHtml ?? null
      )
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
    context?: string
    slideUrl?: string
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
                {entry.tweetEmbedHtml ? (
                  <div class="entry__content-split">
                    <div class="entry__left">
                      <div
                        class="tweet-embed"
                        dangerouslySetInnerHTML={{ __html: entry.tweetEmbedHtml }}
                      />
                    </div>
                    <div class="entry__right">
                      <div class="entry__context">
                        <span class="entry__context-label">利用文脈</span>
                        <p>{entry.context}</p>
                      </div>
                      {entry.slideUrl && (
                        <p class="entry__slide">
                          <a href={entry.slideUrl} target="_blank" rel="noopener noreferrer">
                            発表スライドを見る
                          </a>
                        </p>
                      )}
                      {entry.note && <p class="entry__note">{entry.note}</p>}
                      {entry.tags.length > 0 && (
                        <ul class="tag-list">
                          {entry.tags.map((tag) => (
                            <li class="tag" key={`${entry.id}-${tag}`}>
                              #{tag}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <a class="entry__link" href={entry.url} target="_blank" rel="noopener noreferrer">
                      {entry.url}
                    </a>
                    <div class="entry__context">
                      <span class="entry__context-label">利用文脈</span>
                      <p>{entry.context}</p>
                    </div>
                    {entry.slideUrl && (
                      <p class="entry__slide">
                        <a href={entry.slideUrl} target="_blank" rel="noopener noreferrer">
                          発表スライドを見る
                        </a>
                      </p>
                    )}
                    {entry.note && <p class="entry__note">{entry.note}</p>}
                    {entry.tags.length > 0 && (
                      <ul class="tag-list">
                        {entry.tags.map((tag) => (
                          <li class="tag" key={`${entry.id}-${tag}`}>
                            #{tag}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
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
            どんな文脈で利用しましたか？
            <textarea
              name="context"
              rows={3}
              placeholder="例：LTイベントでAI×デザインの事例として紹介しました。"
              required
              defaultValue={defaults?.context ?? ''}
            />
          </label>
          <label>
            どんな発表で利用したか？（スライドURL 任意）
            <input
              type="url"
              name="slideUrl"
              placeholder="https://speakerdeck.com/... (任意)"
              value={defaults?.slideUrl ?? ''}
            />
          </label>
          <label>
            メモ（任意）
            <textarea
              name="note"
              rows={3}
              placeholder="補足メモがあれば書いておきましょう。"
              defaultValue={defaults?.note ?? ''}
            />
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
        __html: `(function(){function init(){if(typeof window==="undefined"||typeof document==="undefined")return;if(typeof HTMLDialogElement==="undefined")return;var modal=document.getElementById("entry-modal");if(!modal||!(modal instanceof HTMLDialogElement))return;var openButtons=document.querySelectorAll("[data-open-modal]");var closeButtons=document.querySelectorAll("[data-close-modal]");function openModal(event){if(event&&event.preventDefault)event.preventDefault();modal.showModal()}function closeModal(event){if(event&&event.preventDefault)event.preventDefault();modal.close()}openButtons.forEach(function(button){button.addEventListener("click",openModal)});closeButtons.forEach(function(button){button.addEventListener("click",closeModal)});modal.addEventListener("click",function(event){if(event.target===modal){modal.close()}});document.addEventListener("keydown",function(event){if(event.key==="Escape"&&modal.open){modal.close()}});if(modal.dataset.forceOpen==="true"){modal.showModal();delete modal.dataset.forceOpen}var urlInput=document.querySelector('input[name="url"]');var contextInput=document.querySelector('textarea[name="context"]');var noteInput=document.querySelector('textarea[name="note"]');if(urlInput&&contextInput){var debounceTimer=null;function extractTweetText(html){try{var parser=new DOMParser();var doc=parser.parseFromString(html,"text/html");var blockquote=doc.querySelector("blockquote");if(!blockquote)return null;var paragraphs=blockquote.querySelectorAll("p");if(paragraphs.length===0)return null;var text=paragraphs[0].textContent||"";return text.trim()}catch(e){console.error("Failed to parse tweet HTML",e);return null}}function handleUrlChange(){var url=urlInput.value.trim();if(!url)return;var isTwitterUrl=/^https?:\\/\\/(twitter\\.com|x\\.com)\\/\\w+\\/status\\/\\d+/.test(url);if(!isTwitterUrl)return;if(contextInput.value.trim()!=="")return;var oembedUrl="/api/oembed?url="+encodeURIComponent(url);fetch(oembedUrl).then(function(response){if(!response.ok)throw new Error("Failed to fetch oembed");return response.json()}).then(function(data){if(contextInput.value.trim()!=="")return;var tweetText=data.html?extractTweetText(data.html):null;if(tweetText){contextInput.value=data.author_name+"さんの投稿「"+tweetText+"」を参照しました。"}else if(data.author_name){contextInput.value=data.author_name+"さんの投稿を参照しました。"}}).catch(function(error){console.log("oEmbed fetch error:",error)})}urlInput.addEventListener("blur",function(){if(debounceTimer){clearTimeout(debounceTimer)}debounceTimer=setTimeout(handleUrlChange,300)})}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",init,{once:true})}else{init()}})();`,
      }}
    />
    <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
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
  const result = validateInput(formData.url, formData.note, formData.context, formData.slideUrl, formData.tags)

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
          context: typeof formData.context === 'string' ? formData.context : '',
          slideUrl: typeof formData.slideUrl === 'string' ? formData.slideUrl : '',
          tags: typeof formData.tags === 'string' ? formData.tags : '',
        }}
        showModal
      />,
      400
    )
  }

  try {
    await insertEntry(
      c.env.DB,
      result.data.url,
      result.data.note,
      result.data.context,
      result.data.slideUrl,
      result.data.tags
    )
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
          context: typeof formData.context === 'string' ? formData.context : '',
          slideUrl: typeof formData.slideUrl === 'string' ? formData.slideUrl : '',
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
  const result = validateInput(record.url, record.note, record.context, record.slideUrl, record.tags)

  if (!result.ok) {
    return c.json({ error: result.error }, 400)
  }

  try {
    const entry = await insertEntry(
      c.env.DB,
      result.data.url,
      result.data.note,
      result.data.context,
      result.data.slideUrl,
      result.data.tags
    )
    return c.json(entry, 201)
  } catch (error) {
    console.error('Failed to insert entry via API', error)
    return c.json({ error: '保存に失敗しました。' }, 500)
  }
})

app.get('/api/oembed', async (c) => {
  const targetUrl = c.req.query('url')

  if (!targetUrl || typeof targetUrl !== 'string') {
    return c.json({ error: 'URLパラメータが必要です。' }, 400)
  }

  // Check if it's a Twitter/X URL
  const isTwitterUrl = /^https?:\/\/(twitter\.com|x\.com)\/\w+\/status\/\d+/.test(targetUrl)

  if (!isTwitterUrl) {
    return c.json({ error: 'Twitter/XのURLのみサポートしています。' }, 400)
  }

  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}&maxwidth=500`
    const response = await fetch(oembedUrl)

    if (!response.ok) {
      return c.json({ error: 'oEmbed APIの呼び出しに失敗しました。' }, response.status)
    }

    const data = await response.json()
    return c.json(data)
  } catch (error) {
    console.error('oEmbed API error', error)
    return c.json({ error: 'oEmbed APIの呼び出し中にエラーが発生しました。' }, 500)
  }
})

export default app
