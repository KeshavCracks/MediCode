import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import * as plugin from '../src/index.ts'
import {
  Fetcher, formatTranscript, hostAllowed, parseCaptions, parseCaptionTracks, parseEfetch, parseEsummary, parseRss,
  parseWhoJson, pickTrack, plainText, scrubQuery, esearchUrl, youtubeId,
} from '../src/index.ts'

const EFETCH = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">31234567</PMID><Article><Journal><Title>The Lancet</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal><ArticleTitle>Early vasopressin in septic shock: a &lt;randomised&gt; trial.</ArticleTitle><Abstract><AbstractText Label="BACKGROUND">Septic shock carries <i>high</i> mortality.</AbstractText><AbstractText Label="RESULTS">No difference in 28-day mortality (RR 0.96).</AbstractText></Abstract><ELocationID EIdType="doi" ValidYN="Y">10.1016/S0140-6736(24)00001-1</ELocationID><PublicationTypeList><PublicationType>Randomized Controlled Trial</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`

const ESUMMARY = JSON.stringify({
  result: {
    uids: ['31234567'],
    31234567: {
      title: 'Early vasopressin in septic shock.', fulljournalname: 'Lancet', pubdate: '2024 Mar 2',
      authors: [{ name: 'Rao A' }, { name: 'Smith B' }, { name: 'Lee C' }, { name: 'Diaz D' }],
      articleids: [{ idtype: 'pubmed', value: '31234567' }, { idtype: 'doi', value: '10.1016/x' }], pubtype: ['Randomized Controlled Trial'],
    },
  },
})

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>MMWR</title>
<item><title>Measles outbreak — Texas, 2026</title><link>https://www.cdc.gov/mmwr/volumes/75/wr/mm7501a1.htm</link><pubDate>Thu, 08 Oct 2026 14:00:00 GMT</pubDate><description><![CDATA[<p>Cases rose among <b>unvaccinated</b> children.</p>]]></description></item>
<item><title>Influenza vaccine effectiveness</title><link>https://www.cdc.gov/x</link><pubDate>Thu, 01 Oct 2026 14:00:00 GMT</pubDate><description>Interim &amp;lt;estimates&amp;gt;</description></item>
</channel></rss>`

describe('scrubQuery', () => {
  it('removes identifiers but keeps the clinical question', () => {
    const r = scrubQuery('Mr. Ramesh Kumar MRN 00123456 ph 98765 43210 ramesh@example.com DOB 12/03/1961 vancomycin dosing in AKI')
    expect(r.query).toBe('vancomycin dosing in AKI')
    expect(r.removed).toEqual(expect.arrayContaining(['name', 'id-number', 'phone', 'email', 'date']))
  })

  it('generalises ages over 89 and keeps ordinary numbers', () => {
    expect(scrubQuery('94 year old with hip fracture, eGFR 25').query).toBe('aged 90+ with hip fracture, eGFR 25')
    expect(scrubQuery('amoxicillin 500 mg in pregnancy').removed).toEqual([])
    expect(scrubQuery('call +1 (415) 555-0134 re warfarin INR 3.2').query).toBe('call re warfarin INR 3.2')
  })

  it('handles patient-name phrasing', () => {
    expect(scrubQuery('patient Anita Sharma has sepsis').query).toBe('patient has sepsis')
  })
})

describe('parsers', () => {
  it('builds E-utilities URLs with identity and filters', () => {
    const url = new URL(esearchUrl('sepsis', { max: 5, sort: 'date', minYear: 2020, highEvidence: true }, { tool: 'dsh-medical', email: 'a@b.org' }))
    expect(url.hostname).toBe('eutils.ncbi.nlm.nih.gov')
    expect(url.searchParams.get('term')).toMatch(/^\(sepsis\) AND \(systematic\[sb\]/)
    expect(url.searchParams.get('sort')).toBe('pub_date')
    expect(url.searchParams.get('mindate')).toBe('2020')
    expect(url.searchParams.get('email')).toBe('a@b.org')
    expect(url.searchParams.has('api_key')).toBe(false)
  })

  it('parses esummary and efetch', () => {
    const [s] = parseEsummary(ESUMMARY)
    expect(s).toMatchObject({ pmid: '31234567', year: '2024', authors: 'Rao A, Smith B, Lee C, et al.', doi: '10.1016/x' })
    const [a] = parseEfetch(EFETCH)
    expect(a).toMatchObject({ pmid: '31234567', journal: 'The Lancet', year: '2024', doi: '10.1016/S0140-6736(24)00001-1', types: ['Randomized Controlled Trial'] })
    expect(a?.title).toBe('Early vasopressin in septic shock: a <randomised> trial.')
    expect(a?.abstract).toBe('BACKGROUND: Septic shock carries high mortality.\nRESULTS: No difference in 28-day mortality (RR 0.96).')
  })

  it('parses RSS (CDATA, double-encoded HTML) and WHO DON JSON', () => {
    const items = parseRss(RSS)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ title: 'Measles outbreak — Texas, 2026', link: 'https://www.cdc.gov/mmwr/volumes/75/wr/mm7501a1.htm', date: '2026-10-08', summary: 'Cases rose among unvaccinated children.' })
    expect(items[1]?.summary).toBe('Interim <estimates>')
    const don = parseWhoJson(JSON.stringify({ value: [
      { Title: 'Older item', PublicationDateAndTime: '2026-09-01T00:00:00Z', ItemDefaultUrl: '/2026-DON600' },
      { Title: 'Ebola disease — DRC', PublicationDateAndTime: '2026-10-08T15:16:26Z', UrlName: '2026-DON619' },
    ] }), 'https://www.who.int/emergencies/disease-outbreak-news/item')
    expect(don[0]).toMatchObject({ title: 'Ebola disease — DRC', date: '2026-10-08', link: 'https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON619' })
    expect(don[1]?.link).toBe('https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON600')
  })

  it('handles transcripts: ids, track choice, timedtext and VTT', () => {
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('dQw4w9WgXcQ')
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')).toBe('dQw4w9WgXcQ')
    expect(youtubeId('https://evil.example/watch?v=dQw4w9WgXcQ')).toBeUndefined()
    const html = `var x = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=a&lang=en&kind=asr","languageCode":"en","kind":"asr"},{"baseUrl":"https://www.youtube.com/api/timedtext?v=a&lang=en","languageCode":"en","name":{"simpleText":"English [x]"}}]}}};`
    expect(pickTrack(parseCaptionTracks(html), 'en')?.kind).toBeUndefined()
    const xml = '<transcript><text start="0.5" dur="2">Welcome to grand rounds</text><text start="61" dur="2">Sepsis &amp;amp; fluids</text></transcript>'
    expect(formatTranscript(parseCaptions(xml), 1000).text).toBe('[00:00] Welcome to grand rounds\n[01:01] Sepsis & fluids')
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n\n00:01:05.000 --> 00:01:07.000\n<c>World</c>\n'
    expect(parseCaptions(vtt)).toEqual([{ start: 1, text: 'Hello' }, { start: 65, text: 'World' }])
  })

  it('plainText strips tags and entities', () => {
    expect(plainText('<![CDATA[<b>a</b> &amp;amp; b]]>')).toBe('a & b')
  })
})

describe('Fetcher', () => {
  const base = { allowHosts: ['www.who.int', '.ncbi.nlm.nih.gov'], userAgent: 't', timeoutMs: 5000, maxBytes: 1024, minIntervalMs: 0 }
  const signal = new AbortController().signal

  it('enforces https and the host allowlist', async () => {
    const fetch = vi.fn()
    const f = new Fetcher({ ...base, fetch })
    await expect(f.get('http://www.who.int/x', signal)).rejects.toThrow(/https/)
    await expect(f.get('https://evil.example/x', signal)).rejects.toThrow(/allowlist/)
    await expect(f.get('https://user:pw@www.who.int/', signal)).rejects.toThrow(/credentials/)
    expect(fetch).not.toHaveBeenCalled()
    expect(hostAllowed('eutils.ncbi.nlm.nih.gov', base.allowHosts)).toBe(true)
    expect(hostAllowed('ncbi.nlm.nih.gov.evil.com', base.allowHosts)).toBe(false)
  })

  it('re-checks the allowlist on redirects', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }))
    await expect(new Fetcher({ ...base, fetch }).get('https://www.who.int/x', signal)).rejects.toThrow(/evil\.example.*allowlist/)
  })

  it('follows allowed redirects and caps the body', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/y' } }))
      .mockResolvedValueOnce(new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'text/plain' } }))
    const res = await new Fetcher({ ...base, fetch }).get('https://www.who.int/x', signal)
    expect(res.url).toBe('https://www.who.int/y')
    expect(res.text).toHaveLength(1024)
    expect(res.truncated).toBe(true)
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
  })
})

describe('tools', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  async function setup(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(plugin, { contactEmail: '', ncbiApiKey: '', transcriptLanguage: 'en', maxTranscriptChars: 20000, timeoutMs: 5000, maxBytes: 1 << 20 })
    return ctx
  }

  const run = (ctx: Context, name: string, args: Record<string, unknown>) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('t1'), name, arguments: args,
  })

  it('pubmed_search scrubs the outbound query and fences results', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      urls.push(url.toString())
      if (url.pathname.endsWith('esearch.fcgi')) return Response.json({ esearchresult: { count: '1', idlist: ['31234567'] } })
      return new Response(ESUMMARY, { headers: { 'content-type': 'application/json' } })
    }))
    const ctx = await setup()
    const result = await run(ctx, 'pubmed_search', { query: 'Mrs. Lata Rao MRN 99887766 vasopressin septic shock' })
    expect(result.isError).toBe(false)
    const term = new URL(urls[0] as string).searchParams.get('term')
    expect(term).toBe('vasopressin septic shock')
    const text = JSON.stringify(result)
    expect(text).toContain('PMID 31234567')
    expect(text).toContain('external-content')
    expect(text).toMatch(/removed (?=[^.]*name)(?=[^.]*id-number)/)
  })

  it('medical_feed filters by keyword', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(RSS, { headers: { 'content-type': 'application/rss+xml' } })))
    const ctx = await setup()
    const text = JSON.stringify(await run(ctx, 'medical_feed', { feed: 'cdc-mmwr', query: 'measles' }))
    expect(text).toContain('Measles outbreak')
    expect(text).not.toContain('Influenza vaccine')
  })

  it('pubmed_fetch_abstract rejects non-PMIDs without any network call', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = await setup()
    const result = await run(ctx, 'pubmed_fetch_abstract', { pmids: ['123; DROP TABLE'] })
    expect(result.isError).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
})
