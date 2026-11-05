// The mistake history: fixes kept across sessions for /grammar stats and /grammar review. Plain functions, no engine calls.
import type { GrammarFix } from '../types'
import { isIgnored } from './config'
import type { Ignore } from './config'

/** What kind of mistake a fix corrects; the model picks one, anything else is "other". */
export const KINDS = [
  'spelling',
  'tense',
  'agreement',
  'article',
  'preposition',
  'word order',
  'wrong word',
  'missing word',
  'extra word',
  'other',
] as const
export type Kind = (typeof KINDS)[number]

export const kindOf = (x: unknown): Kind => {
  const k = typeof x === 'string' ? x.trim().toLowerCase().replace(/[-_]+/g, ' ') : ''
  return (KINDS as readonly string[]).includes(k) ? (k as Kind) : 'other'
}

/** One kept fix; `at` is when, in milliseconds since the epoch. */
export type Entry = { from: string; to: string; why: string; kind: Kind; at: number }
/** One day's checks: how many prompts were checked and how many of them had a fix. */
export type Day = { day: string; checked: number; withFixes: number }
export type History = { version: 1; fixes: Entry[]; days: Day[] }

export const EMPTY_HISTORY: History = { version: 1, fixes: [], days: [] }
export const MAX_ENTRIES = 2000
export const KEEP_DAYS = 90
// Kept fixes needed before /grammar review asks the model anything.
export const REVIEW_FROM = 20
// Longer fixes are more likely pasted text than a mistake: not kept.
const MAX_LEN = 60
const DAY_MS = 86_400_000

// Days are UTC dates, the same on every machine.
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * The time span tools/import-history.ts fills: the same days as the period `${days}d` (today and the days before it, UTC),
 * up to the history's first day, or now when there is none. Undefined when the history already starts that early.
 */
export const importWindow = (now: number, days: number, firstDay?: string) => {
  const from = Date.parse(`${dayOf(now - (days - 1) * DAY_MS)}T00:00:00Z`)
  const to = firstDay === undefined ? now : Date.parse(`${firstDay}T00:00:00Z`)
  return to > from ? { from, to } : undefined
}

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)

const entryOf = (e: unknown): Entry[] =>
  isRecord(e) && typeof e.from === 'string' && typeof e.to === 'string' && Number.isFinite(e.at)
    ? [{ from: e.from, to: e.to, why: typeof e.why === 'string' ? e.why : '', kind: kindOf(e.kind), at: e.at as number }]
    : []

const dayEntryOf = (d: unknown): Day[] =>
  isRecord(d) && typeof d.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isFinite(d.checked) && Number.isFinite(d.withFixes)
    ? [{ day: d.day, checked: d.checked as number, withFixes: d.withFixes as number }]
    : []

/** The entries of a file that does not parse whole (two sessions writing at once, say): each line on its own. */
const salvage = (text: string): History => {
  const fixes: Entry[] = []
  const days: Day[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\{.*\})\s*,?\s*$/.exec(line)
    if (m === null) {
      continue
    }
    try {
      const x = JSON.parse(m[1] ?? '') as unknown
      fixes.push(...entryOf(x))
      days.push(...dayEntryOf(x))
    } catch {
      // A torn line: dropped.
    }
  }
  return { version: 1, fixes, days }
}

/**
 * A history file's content; entries that are not well formed are dropped. A file that does not parse whole keeps the
 * lines that do. Throws when nothing in it can be read, so a file that is not a history is left alone.
 */
export const parseHistory = (text: string): History => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const saved = salvage(text)
    if (saved.fixes.length + saved.days.length === 0) {
      throw err
    }
    return saved
  }
  if (!isRecord(raw)) {
    throw new Error('not a JSON object')
  }
  return {
    version: 1,
    fixes: (Array.isArray(raw.fixes) ? raw.fixes : []).flatMap(entryOf),
    days: (Array.isArray(raw.days) ? raw.days : []).flatMap(dayEntryOf),
  }
}

/**
 * The file's text: one day or fix per line, so it reads well when opened. The few day counts go first, so a file cut
 * short while it is written keeps them (parseHistory salvages whole lines) and loses only the newest fixes.
 */
export const historyText = (h: History) => {
  const rows = (xs: readonly unknown[]) => (xs.length === 0 ? '[]' : `[\n${xs.map(x => `  ${JSON.stringify(x)}`).join(',\n')}\n]`)
  return `{\n"version": 1,\n"days": ${rows(h.days)},\n"fixes": ${rows(h.fixes)}\n}\n`
}

// Paths, identifiers, calls, markup, file names and dotfiles: code, not English.
const CODEISH = /[/\\_(){}[\]<>=`@#$|~]|\w\.\w|(^|\s)\.\w/

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** A fix that changes more than case or spacing, which the check doesn't count as a mistake. */
const changesWords = (f: { from: string; to: string }) => norm(f.from) !== norm(f.to)

/** A fix worth keeping: short, more than case, and not code or a file name that slipped past the model. */
export const keepable = (f: GrammarFix) =>
  f.from.trim() !== '' &&
  f.from.length <= MAX_LEN &&
  f.to.length <= MAX_LEN &&
  changesWords(f) &&
  !CODEISH.test(f.from) &&
  !CODEISH.test(f.to)

/** The first UTC day kept: today and the KEEP_DAYS - 1 days before it. */
export const oldestDay = (now: number) => dayOf(now - (KEEP_DAYS - 1) * DAY_MS)

/** Fixes and days before the oldest day kept go, then the oldest fixes past MAX_ENTRIES. */
export const prune = (h: History, now: number): History => {
  const sinceDay = oldestDay(now)
  const since = Date.parse(`${sinceDay}T00:00:00Z`)
  return {
    version: 1,
    fixes: h.fixes.filter(f => f.at >= since).slice(-MAX_ENTRIES),
    days: h.days.filter(d => d.day >= sinceDay).sort((a, b) => a.day.localeCompare(b.day)),
  }
}

/** The history after one checked prompt: the day's counts moved, its keepable fixes added, the old dropped. */
export const record = (h: History, fixes: readonly GrammarFix[], now: number): History => {
  const day = dayOf(now)
  const today = h.days.find(d => d.day === day)
  const days = [
    ...h.days.filter(d => d.day !== day),
    { day, checked: (today?.checked ?? 0) + 1, withFixes: (today?.withFixes ?? 0) + (fixes.length > 0 ? 1 : 0) },
  ]
  const kept = fixes
    .filter(keepable)
    .map(f => ({ from: f.from.trim(), to: f.to.trim(), why: f.why.trim(), kind: kindOf(f.kind), at: now }))
  return prune({ version: 1, fixes: [...h.fixes, ...kept], days }, now)
}

/** Two histories as one: fixes in time order, a day's counts summed, then pruned as of `now`. */
export const merge = (a: History, b: History, now: number): History => {
  const days = new Map<string, Day>()
  for (const d of [...a.days, ...b.days]) {
    const seen = days.get(d.day)
    days.set(d.day, { day: d.day, checked: (seen?.checked ?? 0) + d.checked, withFixes: (seen?.withFixes ?? 0) + d.withFixes })
  }
  const fixes = [...a.fixes, ...b.fixes].sort((x, y) => x.at - y.at)
  return prune({ version: 1, fixes, days: [...days.values()] }, now)
}

/** The kept fixes, less any the ignore list names now (it may have grown since they were kept). */
export const visible = (h: History, ignore: Ignore) => h.fixes.filter(f => changesWords(f) && !isIgnored(ignore, f.from))

export type Pair = { from: string; to: string; kind: Kind; why: string; count: number }

/** The fixes grouped by their words, case and spacing aside, most frequent first; each group takes its most common kind. */
export const pairsOf = (fixes: readonly Entry[]): Pair[] => {
  const by = new Map<string, Pair & { kinds: Map<Kind, number> }>()
  for (const f of fixes) {
    const key = `${norm(f.from)}\u0000${norm(f.to)}`
    const p = by.get(key) ?? { from: norm(f.from), to: norm(f.to), kind: f.kind, why: '', count: 0, kinds: new Map() }
    p.count += 1
    p.why ||= f.why
    p.kinds.set(f.kind, (p.kinds.get(f.kind) ?? 0) + 1)
    by.set(key, p)
  }
  return [...by.values()]
    .map(({ kinds, ...p }) => ({ ...p, kind: [...kinds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? p.kind }))
    .sort((a, b) => b.count - a.count)
}

const arrow = (p: { from: string; to: string }) => `${p.from} → ${p.to === '' ? '(drop it)' : p.to}`
const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(1, of))}%`

/** The share of checked prompts with a fix in the last 30 days and the 30 before, when each has enough checks to say. */
export const trendOf = (days: readonly Day[], now: number) => {
  const cut1 = dayOf(now - 30 * DAY_MS)
  const cut2 = dayOf(now - 60 * DAY_MS)
  const sum = (ds: readonly Day[]) => ds.reduce((a, d) => ({ checked: a.checked + d.checked, withFixes: a.withFixes + d.withFixes }), { checked: 0, withFixes: 0 })
  const recent = sum(days.filter(d => d.day > cut1))
  const before = sum(days.filter(d => d.day > cut2 && d.day <= cut1))
  return recent.checked < 10 || before.checked < 10
    ? undefined
    : { recent: recent.withFixes / recent.checked, before: before.withFixes / before.checked }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `2026-10-03` as `Oct 3`. */
const shortDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${Number(day.slice(8, 10))}`
const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)

/** UTC days, both ends included. */
export type Span = { fromDay: string; toDay: string }
/** What stats and a review cover, and the stretch just before it of the same length to compare with. */
export type Period = Span & { label: string; before?: Span & { label: string } }

export const PERIOD_HELP = 'A period is 7d, 30d or since 2026-10-01 (UTC days, today included); with none, everything kept.'

/** A period from the command's words: none (everything kept), `7d` (the last 7 days, today included), `since 2026-10-01`. A message when it doesn't read. */
export const parsePeriod = (words: string, now: number): Period | string => {
  const today = dayOf(now)
  const oldest = oldestDay(now)
  const w = words.trim().toLowerCase()
  // The stretch before, cut to the days the history keeps, and named for what is left of it; none when nothing is.
  const withBefore = (fromDay: string, label: string, beforeLabel: string): Period => {
    const n = daysBetween(fromDay, today) + 1
    const toDay = addDays(fromDay, -1)
    const start = addDays(fromDay, -n)
    if (toDay < oldest) {
      return { fromDay, toDay: today, label }
    }
    if (start >= oldest) {
      return { fromDay, toDay: today, label, before: { fromDay: start, toDay, label: beforeLabel } }
    }
    const kept = daysBetween(oldest, toDay) + 1
    return { fromDay, toDay: today, label, before: { fromDay: oldest, toDay, label: `the ${kept} kept day${kept === 1 ? '' : 's'} before` } }
  }
  if (w === '' || w === 'all') {
    return { fromDay: oldest, toDay: today, label: 'everything kept' }
  }
  const d = /^(\d+)\s*d(ays?)?$/.exec(w)
  if (d !== null) {
    const n = Number(d[1])
    if (n < 1 || n > KEEP_DAYS) {
      return `The history keeps ${KEEP_DAYS} days: pick 1d to ${KEEP_DAYS}d.`
    }
    const days = `${n} day${n === 1 ? '' : 's'}`
    return withBefore(addDays(today, -(n - 1)), n === 1 ? 'today' : `last ${days}`, n === 1 ? 'yesterday' : `the ${days} before`)
  }
  const since = /^since\s+(\d{4}-\d{2}-\d{2})$/.exec(w)
  if (since !== null) {
    const day = since[1] ?? ''
    const at = Date.parse(`${day}T00:00:00Z`)
    if (Number.isNaN(at) || dayOf(at) !== day || day > today) {
      return `${day} is not a day up to today. ${PERIOD_HELP}`
    }
    const from = day < oldest ? oldest : day
    return withBefore(from, `since ${shortDay(from)}`, 'the same stretch before')
  }
  return PERIOD_HELP
}

/** The part of a history inside a span. */
export const within = (h: History, span: Span): History => ({
  version: 1,
  fixes: h.fixes.filter(f => dayOf(f.at) >= span.fromDay && dayOf(f.at) <= span.toDay),
  days: h.days.filter(d => d.day >= span.fromDay && d.day <= span.toDay),
})

const counts = (days: readonly Day[]) =>
  days.reduce((a, d) => ({ checked: a.checked + d.checked, withFixes: a.withFixes + d.withFixes }), { checked: 0, withFixes: 0 })

export type Trend = { recent: number; before: number; fewer: boolean | null; text: string }

/** This period's share of prompts with a fix against the stretch before it (everything kept: the last 30 days against the 30 before). */
export const compare = (h: History, period: Period, now: number): Trend | undefined => {
  const verdict = (recent: number, before: number) => {
    const [a, b] = [Math.round(recent * 100), Math.round(before * 100)]
    return { a, b, fewer: a < b ? true : a > b ? false : null, word: a < b ? 'Fewer' : a > b ? 'More' : 'Same' }
  }
  if (period.before === undefined) {
    const t = trendOf(h.days, now)
    if (t === undefined) {
      return undefined
    }
    const v = verdict(t.recent, t.before)
    return { ...t, fewer: v.fewer, text: `${v.word === 'Same' ? 'Same as' : `${v.word} than`} before: ${v.a}% of prompts had a fix in the last 30 days, ${v.b}% in the 30 before.` }
  }
  const now1 = counts(within(h, period).days)
  const then = counts(within(h, period.before).days)
  if (now1.checked < 10 || then.checked < 10) {
    return undefined
  }
  const [recent, before] = [now1.withFixes / now1.checked, then.withFixes / then.checked]
  const v = verdict(recent, before)
  return { recent, before, fewer: v.fewer, text: `${v.word === 'Same' ? 'Same as' : `${v.word} than`} ${period.before.label} (${v.b}%)` }
}

/** The figures at the top of a review, and of stats. */
export type Summary = {
  label: string
  range: string
  checked: number
  withFixes: number
  fixes: number
  trend?: Trend
  kinds: { kind: Kind; n: number; share: number }[]
  top?: Pair
}

export const summaryOf = (h: History, ignore: Ignore, period: Period, now: number): Summary => {
  const part = within(h, period)
  const fixes = visible(part, ignore)
  const { checked, withFixes } = counts(part.days)
  const first = [part.days[0]?.day, fixes[0] === undefined ? undefined : dayOf(fixes[0].at)].filter((d): d is string => d !== undefined).sort()[0]
  const from = period.before === undefined && first !== undefined ? first : period.fromDay
  const kinds = KINDS.map(kind => ({ kind, n: fixes.filter(f => f.kind === kind).length }))
    .filter(k => k.n > 0)
    .sort((a, b) => b.n - a.n)
    .map(k => ({ ...k, share: k.n / fixes.length }))
  const top = pairsOf(fixes)[0]
  return {
    label: period.label,
    range: from === period.toDay ? shortDay(from) : `${shortDay(from)} – ${shortDay(period.toDay)}`,
    checked,
    withFixes,
    fixes: fixes.length,
    trend: compare(h, period, now),
    kinds,
    top: top !== undefined && top.count > 1 ? top : undefined,
  }
}

/** The summary as plain lines: what a review's row holds where the panel isn't drawn. The model never sees it. */
export const summaryText = (m: Summary) =>
  [
    `Grammar review · ${m.label} (${m.range})`,
    `${m.checked} prompts · ${pct(m.withFixes, m.checked)} with a fix · ${m.fixes} fixes`,
    ...(m.trend === undefined ? [] : [m.trend.text]),
    m.kinds
      .slice(0, 3)
      .map(k => `${k.kind} ${pct(k.n, m.fixes)}`)
      .join(' · '),
    ...(m.top === undefined ? [] : [`most repeated: ${arrow(m.top)} ×${m.top.count}`]),
  ].join('\n')

/** What /grammar stats prints, for a period (everything kept when none is given). */
export const statsText = (h: History, ignore: Ignore, now: number, path: string, on: boolean, period?: Period, words = '', reviewer = 'Sonnet') => {
  const p = period ?? (parsePeriod('', now) as Period)
  const where = `Kept in ${path}.${on ? '' : ' The history is off: /grammar history on keeps new fixes.'}`
  if (h.fixes.length === 0 && h.days.length === 0) {
    return `Nothing kept yet. ${on ? 'Fixes are kept from your next checked prompt.' : 'The history is off: /grammar history on keeps fixes from now on.'}`
  }
  const m = summaryOf(h, ignore, p, now)
  if (m.checked === 0 && m.fixes === 0) {
    return `Nothing kept for ${p.label}. ${where}`
  }
  const fixes = visible(within(h, p), ignore)
  const label = p.label.charAt(0).toUpperCase() + p.label.slice(1)
  const lines = [`${label} (${m.range}): ${m.checked} prompts checked, ${m.withFixes} with a fix (${pct(m.withFixes, m.checked)}), ${m.fixes} fixes kept.`]
  if (m.trend !== undefined) {
    lines.push(p.before === undefined ? m.trend.text : `${m.trend.text}.`)
  }
  const pairs = pairsOf(fixes)
  if (m.kinds.length > 0) {
    const width = Math.max(...m.kinds.map(k => k.kind.length))
    lines.push('', 'By kind:')
    for (const { kind, n } of m.kinds) {
      const top = pairs.find(x => x.kind === kind)
      const eg = top === undefined ? '' : `  e.g. ${arrow(top)}`
      lines.push(`  ${kind.padEnd(width)}  ${String(n).padStart(4)}  ${pct(n, m.fixes).padStart(4)}${eg}`)
    }
  }
  const repeated = pairs.filter(x => x.count > 1).slice(0, 10)
  lines.push('', repeated.length > 0 ? 'Repeated fixes:' : 'No fix repeated yet.')
  for (const x of repeated) {
    lines.push(`  ×${String(x.count).padEnd(3)} ${arrow(x)}`)
  }
  const forPeriod = words.trim() === '' ? '' : ` ${words.trim()}`
  lines.push(
    '',
    m.fixes >= REVIEW_FROM
      ? `/grammar review${forPeriod}: advice on these from ${reviewer} (one call).`
      : `/grammar review gives advice from ${REVIEW_FROM} fixes; ${m.fixes} so far.`,
    where,
  )
  return lines.join('\n')
}

// Grouped fixes sent to the review, most frequent first.
const MAX_REVIEW_PAIRS = 300

/** The review's prompt: the counts by kind, then each grouped fix with its count. */
export const reviewInput = (fixes: readonly Entry[]) => {
  const counts = KINDS.map(kind => ({ kind, n: fixes.filter(f => f.kind === kind).length }))
    .filter(k => k.n > 0)
    .sort((x, y) => y.n - x.n)
  const pairs = pairsOf(fixes).slice(0, MAX_REVIEW_PAIRS)
  return [
    `${fixes.length} fixes. By kind: ${counts.map(k => `${k.kind} ${k.n}`).join(', ')}.`,
    'Each fix as "count× wrong → right (kind; why)", most frequent first:',
    ...pairs.map(p => `${p.count}× ${arrow(p)} (${p.kind}${p.why === '' ? '' : `; ${p.why}`})`),
  ].join('\n')
}

export const REVIEW_SYSTEM = `You coach a non-native English speaker who writes prompts to a coding assistant. You get the fixes a proofreader made to their prompts over time, grouped, with how often each came up.
Find the 3 to 5 habits behind the most mistakes, most frequent first. For each: a numbered line naming the habit and the rule that fixes it, in plain words, then one to three of their own fixes as examples, each on its own line as "  wrong → right".
Skip one-off typos unless they share a pattern. If a fix looks like the proofreader's own mistake rather than the writer's, leave it out.
Plain text only: no markdown, no headings, no bold, no intro and no closing line.`

// Earlier asks and reviews a follow-up sends along, oldest first.
export const ASK_MEMORY = 5
// A question longer than this is cut; so is a remembered answer.
export const MAX_QUESTION = 1000
export const MAX_ANSWER = 2000
// Fixes from this session's latest prompts sent with a question.
export const ASK_RECENT = 10

/** One remembered exchange: what was asked (a question, or the review command) and the answer. */
export type Turn = { q: string; a: string }

/**
 * /grammar ask's words: a period first when they start with one (`7d`, `since 2026-10-01`), then the question. Only those
 * compact forms count as a period, so a question that starts with "all" or "2 days" stays whole. A message when the
 * period doesn't read.
 */
export const splitAsk = (words: string, now: number): { period: Period; question: string } | string => {
  const w = words.trim()
  const head = /^(\d+d|since\s+\S+)(?:\s+|$)/i.exec(w)
  const period = parsePeriod(head === null ? '' : head[1] ?? '', now)
  if (typeof period === 'string') {
    return period
  }
  return { period, question: head === null ? w : w.slice(head[0].length).trim() }
}

/** The ask's prompt: the period's grouped fixes, this session's latest fixes, the remembered exchanges, then the question. */
export const askInput = (fixes: readonly Entry[], label: string, recent: readonly GrammarFix[], turns: readonly Turn[], question: string) => {
  const parts = [`Their kept fixes (${label}): ${fixes.length === 0 ? 'none kept.' : `\n${reviewInput(fixes)}`}`]
  if (recent.length > 0) {
    parts.push(['Fixes in their latest prompts, newest first:', ...recent.map(f => `${arrow(f)}${f.why === '' ? '' : ` (${f.why})`}`)].join('\n'))
  }
  if (turns.length > 0) {
    parts.push(['Earlier in this conversation, oldest first:', ...turns.map(t => `Q: ${t.q}\nA: ${t.a}`)].join('\n\n'))
  }
  parts.push(`Their question: ${question}`)
  return parts.join('\n\n')
}

export const ASK_SYSTEM = `You coach a non-native English speaker who writes prompts to a coding assistant, and answer their questions about English. You get the fixes a proofreader made to their prompts over time (grouped, with counts), the fixes in their latest prompts, and what was asked and answered earlier in this conversation.
Answer the question directly, in a few short paragraphs at most. When their own fixes show the point, give one to three of them as examples, each on its own line as "  wrong → right". Use only fixes you were given and never invent mistakes they made. When there are too few fixes to see a pattern, say so and answer in general terms.
If the question is not about English or their writing, say in one line that you only answer questions about English.
Plain text only: no markdown, no headings, no bold, no intro and no closing line.`
