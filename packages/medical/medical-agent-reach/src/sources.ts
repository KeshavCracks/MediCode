/**
 * Parsers and URL builders for PubMed (NCBI E-utilities), WHO/CDC feeds and
 * public video transcripts. Pure functions — all network I/O lives in the
 * plugin, so these are unit-tested against fixtures.
 *
 * @module @deepseek-ai/dsh-medical-agent-reach/sources
 */

import { attr, decodeEntities, plainText, tagAll, tagFirst, truncate, xmlText } from './net.ts'

// ---------------------------------------------------------------------------
// PubMed
// ---------------------------------------------------------------------------

export const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

export interface EutilsIdentity {
  tool: string
  email?: string | undefined
  apiKey?: string | undefined
}

function eutilsUrl(endpoint: string, params: Record<string, string | undefined>, id: EutilsIdentity): string {
  const url = new URL(`${EUTILS}/${endpoint}`)
  for (const [k, v] of Object.entries({ ...params, tool: id.tool, email: id.email, api_key: id.apiKey })) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v)
  }
  return url.toString()
}

export interface SearchOptions {
  max: number
  sort: 'relevance' | 'date'
  minYear?: number | undefined
  /** Restrict to systematic reviews, meta-analyses, RCTs and guidelines. */
  highEvidence?: boolean | undefined
}

export const HIGH_EVIDENCE_FILTER = '(systematic[sb] OR meta-analysis[pt] OR randomized controlled trial[pt] OR guideline[pt] OR practice guideline[pt])'

export function esearchUrl(query: string, opts: SearchOptions, id: EutilsIdentity): string {
  const term = opts.highEvidence ? `(${query}) AND ${HIGH_EVIDENCE_FILTER}` : query
  return eutilsUrl('esearch.fcgi', {
    db: 'pubmed',
    term,
    retmode: 'json',
    retmax: String(opts.max),
    sort: opts.sort === 'date' ? 'pub_date' : 'relevance',
    ...(opts.minYear ? { datetype: 'pdat', mindate: String(opts.minYear), maxdate: '3000' } : {}),
  }, id)
}

export function esummaryUrl(pmids: readonly string[], id: EutilsIdentity): string {
  return eutilsUrl('esummary.fcgi', { db: 'pubmed', id: pmids.join(','), retmode: 'json' }, id)
}

export function efetchUrl(pmids: readonly string[], id: EutilsIdentity): string {
  return eutilsUrl('efetch.fcgi', { db: 'pubmed', id: pmids.join(','), rettype: 'abstract', retmode: 'xml' }, id)
}

export function parseEsearch(json: string): { count: number; ids: string[] } {
  const data = JSON.parse(json) as { esearchresult?: { count?: string; idlist?: string[]; ERROR?: string } }
  if (!data.esearchresult) throw new Error('unexpected E-utilities response.')
  if (data.esearchresult.ERROR) throw new Error(`PubMed: ${data.esearchresult.ERROR}`)
  return { count: Number(data.esearchresult.count ?? 0), ids: data.esearchresult.idlist ?? [] }
}

export interface ArticleSummary {
  pmid: string
  title: string
  journal: string
  year: string
  authors: string
  doi?: string | undefined
  types: string[]
}

export function parseEsummary(json: string): ArticleSummary[] {
  const data = JSON.parse(json) as { result?: Record<string, unknown> & { uids?: string[] } }
  const result = data.result
  if (!result) return []
  return (result.uids ?? []).flatMap((uid) => {
    const r = result[uid] as {
      title?: string; fulljournalname?: string; source?: string; pubdate?: string
      authors?: { name: string }[]; articleids?: { idtype: string; value: string }[]; pubtype?: string[]
    } | undefined
    if (!r) return []
    const names = (r.authors ?? []).map(a => a.name)
    return [{
      pmid: uid,
      title: xmlText(r.title ?? ''),
      journal: r.fulljournalname ?? r.source ?? '',
      year: /\d{4}/.exec(r.pubdate ?? '')?.[0] ?? '',
      authors: names.length > 3 ? `${names.slice(0, 3).join(', ')}, et al.` : names.join(', '),
      doi: r.articleids?.find(a => a.idtype === 'doi')?.value,
      types: r.pubtype ?? [],
    }]
  })
}

export interface Abstract {
  pmid: string
  title: string
  journal: string
  year: string
  doi?: string | undefined
  types: string[]
  abstract: string
}

export function parseEfetch(xml: string): Abstract[] {
  return tagAll(xml, 'PubmedArticle').map((article) => {
    const parts = [...article.matchAll(/<AbstractText(?:\s([^>]*))?>([\s\S]*?)<\/AbstractText>/g)].map((m) => {
      const label = /Label="([^"]*)"/.exec(m[1] ?? '')?.[1]
      const body = xmlText(m[2] ?? '')
      return label ? `${decodeEntities(label)}: ${body}` : body
    })
    const doiMatch = /<ELocationID[^>]*EIdType="doi"[^>]*>([^<]+)<\/ELocationID>/.exec(article)
      ?? /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/.exec(article)
    const pubDate = tagFirst(article, 'PubDate') ?? ''
    return {
      pmid: xmlText(tagFirst(article, 'PMID') ?? ''),
      title: xmlText(tagFirst(article, 'ArticleTitle') ?? ''),
      journal: xmlText(tagFirst(tagFirst(article, 'Journal') ?? '', 'Title') ?? ''),
      year: xmlText(tagFirst(pubDate, 'Year') ?? /\d{4}/.exec(tagFirst(pubDate, 'MedlineDate') ?? '')?.[0] ?? ''),
      doi: doiMatch?.[1]?.trim(),
      types: tagAll(article, 'PublicationType').map(xmlText),
      abstract: parts.join('\n') || '(no abstract available)',
    }
  })
}

export function formatCitation(a: { pmid: string; title: string; journal: string; year: string; doi?: string | undefined }): string {
  return `${a.title} ${a.journal}${a.year ? ` (${a.year})` : ''}. PMID ${a.pmid}${a.doi ? `, doi:${a.doi}` : ''} — https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/`
}

// ---------------------------------------------------------------------------
// WHO / CDC feeds
// ---------------------------------------------------------------------------

export interface FeedSource {
  id: string
  title: string
  /** `who-json`: WHO Sitefinity OData API (the WHO RSS feeds are no longer updated). */
  format: 'rss' | 'who-json'
  url: string
  /** `who-json` only: prefix for each item's `ItemDefaultUrl`. */
  linkBase?: string | undefined
}

/** Curated public-health feeds (verified live 2026-10-11). */
export const FEEDS: readonly FeedSource[] = [
  {
    id: 'who-news', title: 'WHO — News', format: 'who-json', linkBase: 'https://www.who.int/news/item',
    url: 'https://www.who.int/api/news/newsitems?$orderby=PublicationDateAndTime%20desc&$top=30&$select=Title,PublicationDateAndTime,ItemDefaultUrl,UrlName',
  },
  {
    id: 'who-outbreaks', title: 'WHO — Disease Outbreak News', format: 'who-json', linkBase: 'https://www.who.int/emergencies/disease-outbreak-news/item',
    url: 'https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDateAndTime%20desc&$top=30&$select=Title,PublicationDateAndTime,ItemDefaultUrl,UrlName,Summary',
  },
  { id: 'cdc-mmwr', title: 'CDC — Morbidity and Mortality Weekly Report', format: 'rss', url: 'https://tools.cdc.gov/api/v2/resources/media/342778.rss' },
  { id: 'cdc-outbreaks', title: 'CDC — US-based outbreaks', format: 'rss', url: 'https://tools.cdc.gov/api/v2/resources/media/285676.rss' },
  { id: 'cdc-newsroom', title: 'CDC — Newsroom', format: 'rss', url: 'https://tools.cdc.gov/api/v2/resources/media/132608.rss' },
]

export interface FeedItem {
  title: string
  link: string
  date: string
  summary: string
}

function isoDate(raw: string): string {
  const t = Date.parse(raw)
  return Number.isNaN(t) ? raw.trim() : new Date(t).toISOString().slice(0, 10)
}

export function parseRss(xml: string): FeedItem[] {
  const items = tagAll(xml, 'item')
  const entries = items.length ? items : tagAll(xml, 'entry')
  return newestFirst(entries.map((item) => {
    const link = plainText(tagFirst(item, 'link') ?? '') || attr(item, 'link', 'href') || ''
    return {
      title: plainText(tagFirst(item, 'title') ?? ''),
      link,
      date: isoDate(plainText(tagFirst(item, 'pubDate') ?? tagFirst(item, 'published') ?? tagFirst(item, 'updated') ?? tagFirst(item, 'a10:updated') ?? '')),
      summary: truncate(plainText(tagFirst(item, 'description') ?? tagFirst(item, 'summary') ?? ''), 320),
    }
  }).filter(i => i.title))
}

/** Newest first; items without a parseable date keep their relative order at the end. */
function newestFirst(items: FeedItem[]): FeedItem[] {
  const t = (i: FeedItem): number => { const v = Date.parse(i.date); return Number.isNaN(v) ? -Infinity : v }
  return items.map((item, index) => ({ item, index })).sort((x, y) => t(y.item) - t(x.item) || x.index - y.index).map(x => x.item)
}

export function parseWhoJson(json: string, linkBase = 'https://www.who.int/news/item'): FeedItem[] {
  const data = JSON.parse(json) as { value?: { Title?: string; PublicationDateAndTime?: string; ItemDefaultUrl?: string; UrlName?: string; Summary?: string }[] }
  return newestFirst((data.value ?? []).map((v) => {
    const path = v.ItemDefaultUrl ?? (v.UrlName ? `/${v.UrlName}` : '')
    return {
      title: plainText(v.Title ?? ''),
      link: `${linkBase}${path}`,
      date: isoDate(v.PublicationDateAndTime ?? ''),
      summary: truncate(plainText(v.Summary ?? ''), 320),
    }
  }).filter(i => i.title))
}

export function filterItems(items: FeedItem[], query: string | undefined, limit: number): FeedItem[] {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const hits = terms.length ? items.filter(i => terms.every(t => `${i.title} ${i.summary}`.toLowerCase().includes(t))) : items
  return hits.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export interface Segment {
  start: number
  text: string
}

export function youtubeId(raw: string): string | undefined {
  if (/^[\w-]{11}$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (url.hostname === 'youtu.be') return /^\/([\w-]{11})/.exec(url.pathname)?.[1]
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) {
      return url.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(url.pathname)?.[1] ?? undefined
    }
  } catch { /* not a URL */ }
  return undefined
}

export interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string | undefined
  name?: string | undefined
}

/** Pull the caption track list out of a YouTube watch page. */
export function parseCaptionTracks(html: string): CaptionTrack[] {
  const start = html.indexOf('"captionTracks":')
  if (start < 0) return []
  const open = html.indexOf('[', start)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    const c = html[i]
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) {
      try {
        const raw = JSON.parse(html.slice(open, i + 1)) as { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } }[]
        return raw.map(t => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind, name: t.name?.simpleText }))
      } catch {
        return []
      }
    }
  }
  return []
}

/** Prefer a human track in the requested language, then auto-generated, then any. */
export function pickTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | undefined {
  const inLang = tracks.filter(t => t.languageCode === lang || t.languageCode.startsWith(`${lang}-`))
  return inLang.find(t => t.kind !== 'asr') ?? inLang[0] ?? tracks.find(t => t.kind !== 'asr') ?? tracks[0]
}

function clock(raw: string): number {
  const parts = raw.replace(',', '.').split(':').map(Number)
  return parts.reduce((acc, p) => acc * 60 + (Number.isFinite(p) ? p : 0), 0)
}

/** Parse YouTube timedtext XML, WebVTT or SRT into segments. */
export function parseCaptions(body: string): Segment[] {
  if (/<text\b/.test(body)) {
    return [...body.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)]
      .map(m => ({ start: Number(m[1]), text: plainText(m[2] ?? '') }))
      .filter(s => s.text)
  }
  const segments: Segment[] = []
  for (const block of body.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const cue = lines.findIndex(l => /-->/.test(l))
    if (cue < 0) continue
    const start = clock((lines[cue] as string).split('-->')[0]?.trim() ?? '0')
    const text = plainText(lines.slice(cue + 1).join(' '))
    if (text && segments.at(-1)?.text !== text) segments.push({ start, text })
  }
  return segments
}

function stamp(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Join segments into paragraphs with a timestamp every `everySeconds`. */
export function formatTranscript(segments: Segment[], maxChars: number, everySeconds = 60): { text: string; truncated: boolean } {
  const paragraphs: string[] = []
  let current: string[] = []
  let paraStart = segments[0]?.start ?? 0
  for (const seg of segments) {
    if (seg.start - paraStart >= everySeconds && current.length) {
      paragraphs.push(`[${stamp(paraStart)}] ${current.join(' ')}`)
      current = []
      paraStart = seg.start
    }
    current.push(seg.text)
  }
  if (current.length) paragraphs.push(`[${stamp(paraStart)}] ${current.join(' ')}`)
  const text = paragraphs.join('\n')
  return text.length > maxChars ? { text: truncate(text, maxChars), truncated: true } : { text, truncated: false }
}
