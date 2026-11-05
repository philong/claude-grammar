// Grammar: after each prompt you send, a model checks its grammar (in English, another language set, or whatever language
// it is in) and a dim line under that prompt in the transcript shows the fixes and, when the phrasing is clearly off, how a
// native speaker would say it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelApiError, Register, RenderNode } from 'claude-code'

import type { GrammarAsk, GrammarCheck, GrammarFix, GrammarReview, GrammarTurn } from '../types'
import {
  AUTO,
  EMPTY,
  ENGLISH,
  LETTERS,
  applyFixes,
  compileIgnore,
  compileSkip,
  cut,
  entriesFrom,
  joinNames,
  keptLanguage,
  languagesOf,
  lettersFor,
  mergeLists,
  parseLists,
  settingsFrom,
  wordCount,
} from './config'
import type { Ignore, Lists, Settings } from './config'
import { fallbackFor, keepFixes, parseReply, system, typedPart } from './check'
import { endpointComplete, hostOf } from './endpoint'
import {
  ASK_MEMORY,
  ASK_RECENT,
  ASK_SYSTEM,
  EMPTY_HISTORY,
  KEEP_DAYS,
  MAX_ANSWER,
  MAX_ENTRIES,
  MAX_QUESTION,
  REVIEW_FROM,
  askInput,
  historyText,
  inLanguage,
  languagesIn,
  parseHistory,
  parsePeriod,
  pickLanguage,
  record,
  reviewInput,
  reviewSystem,
  splitAsk,
  splitLanguage,
  statsText,
  summaryOf,
  summaryText,
  visible,
  within,
} from './history'
import type { History, Summary } from './history'

const isOn = atom({ plugin: 'grammar', key: 'grammarOn' } as const, true)
const isNatural = atom({ plugin: 'grammar', key: 'grammarNatural' } as const, true)
const keepsHistory = atom({ plugin: 'grammar', key: 'grammarHistory' } as const, true)
const reviews = atom({ plugin: 'grammar', key: 'grammarReviews' } as const, [] as GrammarReview[])
const asks = atom({ plugin: 'grammar', key: 'grammarAsks' } as const, [] as GrammarAsk[])
// What follow-ups remember, oldest first: asks and reviews, up to ASK_MEMORY.
const thread = atom({ plugin: 'grammar', key: 'grammarThread' } as const, [] as GrammarTurn[])
const askMemory = atom({ plugin: 'grammar', key: 'grammarAskMemory' } as const, true)
// The latest checks, newest first, each with the prompt it checked.
const checks = atom({ plugin: 'grammar', key: 'grammarChecks' } as const, [] as GrammarCheck[])
const lastId = atom({ plugin: 'grammar', key: 'grammarLastId' } as const, 0)
// The id of the check whose band was hidden; the next check shows again.
const hiddenId = atom({ plugin: 'grammar', key: 'grammarHiddenId' } as const, 0)
const fails = atom({ plugin: 'grammar', key: 'grammarFails' } as const, 0)
const streak = atom({ plugin: 'grammar', key: 'grammarStreak' } as const, 0)

// Where 1.0 kept the two switches; moved into the plugin's settings on the first start of 1.1.
const STORE_ON = 'grammar.on'
const STORE_NATURAL = 'grammar.natural'
// Set once the history notice has shown, so it shows once, not every session the file is missing.
const STORE_ANNOUNCED = 'grammar.historyAnnounced'

const MAX_CHECKS = 200
// Failed checks in a row before the checks pause (a blocked model, an outage).
const MAX_FAILS = 3
// Clean prompts in a row before the mark counts them.
export const STREAK_FROM = 3
const CHECK = '✓'

const NERD_ICONS = { logo: '', error: '', natural: '' }
const PLAIN_ICONS = { logo: '*', error: '!', natural: '>' }
// The desktop app has no Nerd Font and a proportional one: always plain, whatever `icons` says.
const DESKTOP_ICONS = { logo: '✎', error: '!', natural: '↳' }

const same = (a: string, b: string) => {
  const plain = (s: string) => s.trim().toLowerCase().replace(/[.!?]+$/, '')
  return plain(a) === plain(b)
}

/** The natural rewrite, unless it only repeats the prompt or the prompt with its fixes, or drops a word the user said to keep. */
export const usefulNatural = (natural: string | null, text: string, fixes: GrammarFix[], ignore: Ignore = { words: [], matchers: [] }) => {
  if (natural === null || same(natural, text) || same(natural, applyFixes(text, fixes))) {
    return null
  }
  const lower = natural.toLowerCase()
  const dropsKept = ignore.words.some(w => text.toLowerCase().includes(w.toLowerCase()) && !lower.includes(w.toLowerCase()))
  return dropsKept ? null : natural
}

/** The check of the prompt a transcript row shows: the newest with the row's text, or the start of it when another plugin appended a block. */
export const checkFor = (all: GrammarCheck[], rowText: string): GrammarCheck | undefined => {
  const row = rowText.trim()
  return all.find(c => c.text !== '' && (row === c.text || row.startsWith(`${c.text}\n`)))
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A file in the Claude Code config folder (CLAUDE_CONFIG_DIR, else ~/.claude). */
const configFile = async ($: EngineInterface, name: string) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir !== undefined && dir !== '') {
    return `${dir.replace(/[\\/]+$/, '')}/${name}`
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home === undefined || home === '' ? undefined : `${home.replace(/[\\/]+$/, '')}/.claude/${name}`
}

/** The user's grammar.json. */
const globalFile = ($: EngineInterface) => configFile($, 'grammar.json')

/** Where the fixes are kept for /grammar stats and /grammar review. */
const historyFile = ($: EngineInterface) => configFile($, 'grammar-history.json')

/** The project's grammar.json, in its .claude folder. */
const projectFile = async ($: EngineInterface) => `${(await $.session.root()).replace(/[\\/]+$/, '')}/.claude/grammar.json`

// Broken files already reported, so each shows one toast, not one per prompt.
const reported = new Set<string>()

/** A toast once per text, so a broken file shows one, not one per prompt. */
const toastOnce = ($: EngineInterface, note: string, timeoutMs?: number) => {
  if (!reported.has(note)) {
    reported.add(note)
    $.ui.toast(note, timeoutMs === undefined ? undefined : { timeoutMs })
  }
}

/** One file's lists: empty when it is missing; a toast, once, when it does not parse. */
const readLists = async ($: EngineInterface, path: string): Promise<Lists> => {
  try {
    if (!(await $.fs.exists(path))) {
      return EMPTY
    }
    return parseLists(String(await $.fs.read(path)))
  } catch (err) {
    toastOnce($, `grammar: ${path} is ignored: ${message(err)}`)
    return EMPTY
  }
}

/** The kept history: empty when there is none yet. Throws when the file does not parse. */
const readHistory = async ($: EngineInterface, path: string): Promise<History> =>
  (await $.fs.exists(path)) ? parseHistory(String(await $.fs.read(path))) : EMPTY_HISTORY

/**
 * Adds one checked prompt and its fixes to the history file. Read and written in one go, never from a copy in memory,
 * so two sessions at once lose at most the entry of a check that lands in the same moment; a file torn by such a
 * moment keeps the lines that still parse (parseHistory) and is whole again after this write.
 */
const keep = async ($: EngineInterface, fixes: readonly GrammarFix[], lang: string) => {
  const path = await historyFile($)
  if (path === undefined) {
    return
  }
  let h: History
  try {
    h = await readHistory($, path)
  } catch (err) {
    toastOnce($, `grammar: ${path} does not parse (${message(err)}), so no fixes are kept while it doesn't. /grammar history clear starts it over.`)
    return
  }
  await $.fs.write(path, historyText(record(h, fixes, await $.clock.now(), lang)))
}

// This session's history writes (each check's, and a clear), one after another, so none undoes another.
let writing: Promise<unknown> = Promise.resolve()

const inTurn = <T,>(write: () => Promise<T>): Promise<T> => {
  const next = writing.then(write)
  writing = next.catch(() => undefined)
  return next
}

const keepInTurn = ($: EngineInterface, fixes: readonly GrammarFix[], lang: string) =>
  inTurn(() => keep($, fixes, lang)).catch(err => toastOnce($, `grammar: no fixes kept: ${message(err)}`))

/**
 * Once, at the start of a session that will keep fixes but has no history file yet: says where they will go. Not in a
 * project that keeps none, and never again after it has shown.
 */
const announceHistory = async ($: EngineInterface) => {
  const path = await historyFile($)
  if (path === undefined || (await $.store.get(STORE_ANNOUNCED)) === true || (await $.fs.exists(path))) {
    return
  }
  if (!(await loadLists($).catch(() => EMPTY)).history) {
    return
  }
  toastOnce($, `grammar: your fixes will be kept in ${path} for /grammar stats and /grammar review. /grammar history off stops it.`, 12000)
  await $.store.set(STORE_ANNOUNCED, true)
}

/** The global and project lists, joined. */
const loadLists = async ($: EngineInterface): Promise<Lists> => {
  const paths = [await globalFile($), await projectFile($).catch(() => undefined)].filter((p): p is string => p !== undefined)
  const unique = [...new Set(paths)]
  return mergeLists(...(await Promise.all(unique.map(p => readLists($, p)))))
}

/** Saves a setting the way /config does, which reloads the module with it. The reason when it could not. */
const persist = async ($: EngineInterface, field: string, value: boolean): Promise<string | undefined> => {
  try {
    // The row's key as /config names it (an installed copy may carry its marketplace), else the plain one.
    const rows = await $.config.list().catch(() => [])
    const row = rows.find(r => r.provider.plugin.split('@')[0] === 'grammar' && r.key.endsWith(`.${field}`))
    const r = await $.config.set({ key: row?.key ?? `grammar.${field}`, value })
    return 'deny' in r ? String(r.deny) : undefined
  } catch (err) {
    return message(err)
  }
}

const sessionOnly = (reason: string | undefined) => (reason === undefined ? '' : ` (this session only: ${reason})`)

/** Moves the 1.0 switches from $.store into the settings, once. An "off" that could not move still counts. */
const migrate = async ($: EngineInterface) => {
  const moved: Record<string, boolean> = {}
  for (const [key, field] of [
    [STORE_ON, 'enabled'],
    [STORE_NATURAL, 'natural'],
  ] as const) {
    const stored = await $.store.get(key)
    if (stored === undefined) {
      continue
    }
    if (stored === false && (await persist($, field, false)) !== undefined) {
      moved[field] = false
      continue
    }
    await $.store.delete(key)
    if (stored === false) {
      moved[field] = false
    }
  }
  return moved
}

/** The model that answers: the endpoint's when one is set, else `fallback` (the `model` setting for checks, Sonnet for reviews and asks). */
export const modelName = (s: Settings, fallback: string) => (s.endpoint === '' ? fallback : s.endpointModel || 'the default model')

/** What the check is called: "English", "French", "English and French" for a list, or "grammar" in auto. */
export const languageName = (s: Settings) => (s.language === AUTO ? 'grammar' : joinNames(languagesOf(s.language), 'and'))

/** Who checks the prompts, for the help and the on message. */
export const checkerOf = (s: Settings) => (s.endpoint === '' ? s.model : `${modelName(s, s.model)} at ${hostOf(s.endpoint)}`)

const ask = async ($: EngineInterface, s: Settings, text: string, natural: boolean, kind: boolean, ignore: Ignore, timeoutMs?: number) => {
  const request = {
    model: s.model,
    system: system({ natural, language: s.language, dialect: s.dialect, showWhy: s.showWhy, kind, ignore: ignore.words }),
    prompt: cut(text, s.maxChars),
    maxTokens: 4096,
    effort: s.effort,
    timeoutMs: timeoutMs ?? 30000,
  }
  if (s.endpoint !== '') {
    // Longer by default: a local server may first have to load the model.
    return endpointComplete($, s.endpoint, s.endpointModel, s.endpointKey, { ...request, timeoutMs: timeoutMs ?? 120000 })
  }
  try {
    return await $.model.complete(request)
  } catch (err) {
    // Only a request the engine refuses to send rejects (a blocked model, say).
    return { isAnswered: false as const, reason: message(err) }
  }
}

const run = async ($: EngineInterface, s: Settings, id: number, text: string) => {
  // Lists that cannot be read check the prompt as if there were none.
  const lists = await loadLists($).catch(() => EMPTY)
  // A prompt the skip list names: the pending check goes and nothing is sent.
  if (compileSkip(lists.skip).some(re => re.test(text))) {
    await update($, checks, all => all.filter(c => c.id !== id))
    return
  }
  const ignore = compileIgnore(lists.ignore)
  const history = lists.history && (await read($, keepsHistory))
  const r = await ask($, s, text, await read($, isNatural), history, ignore)
  let result: GrammarCheck | null
  if (!r.isAnswered) {
    result = { id, text, status: 'error', fixes: [], error: r.reason }
  } else {
    try {
      const reply = parseReply(r.text, fallbackFor(s.language))
      // A language set is the one kept, however the model spells it; in a list, a language not listed is not checked.
      const language = reply === null ? undefined : keptLanguage(s.language, reply.language)
      const fixes = reply === null ? [] : keepFixes(reply.fixes, text, ignore)
      result =
        reply === null || language === undefined
          ? null
          : { id, text, status: 'done', fixes, natural: usefulNatural(reply.natural, text, fixes, ignore), language }
    } catch (err) {
      result = { id, text, status: 'error', fixes: [], error: message(err) }
    }
  }
  if (result?.status === 'error') {
    const n = await update($, fails, k => k + 1)
    result = { ...result, paused: n === MAX_FAILS }
  } else {
    await update($, fails, () => 0)
  }
  if (result?.status === 'done') {
    // Clean: no fixes and no native-speaker line. A failed check or another language leaves the streak as it is.
    const clean = result.fixes.length === 0 && (!(await read($, isNatural)) || (result.natural ?? null) === null)
    const n = await update($, streak, k => (clean ? k + 1 : 0))
    result = clean ? { ...result, streak: n } : result
  }
  const final = result
  // Not a language checked: the pending check goes, so the row shows nothing.
  await update($, checks, all => all.flatMap(c => (c.id !== id ? [c] : final === null ? [] : [final])))
  // A prompt that was checked counts toward the history, clean or not; the line is drawn first.
  if (history && final?.status === 'done') {
    await keepInTurn($, final.fixes, final.language ?? ENGLISH)
  }
  await showElsewhere($, s, final)
}

/** The fixes and the native-speaker line as plain text. */
export const plainText = (fixes: readonly GrammarFix[], natural: string | null, showWhy: boolean) => {
  const list = fixes.map(f => `${f.from} → ${f.to === '' ? '(remove)' : f.to}${showWhy && f.why !== '' ? ` (${f.why})` : ''}`)
  return `${list.join('  ·  ')}${natural === null ? '' : `${list.length > 0 ? '\n' : ''}↳ ${natural}`}`
}

/** A clean check as plain text, with the streak once it is long enough. */
export const cleanText = (n: number) => `${CHECK} no mistakes${n >= STREAK_FROM ? ` · ${n} in a row` : ''}`

/** Shows a check's result as a transcript line or a toast where the line under the prompt isn't drawn (the desktop app), as `desktop` says. */
const showElsewhere = async ($: EngineInterface, s: Settings, final: GrammarCheck | null) => {
  try {
    if (final === null || s.desktop === 'off' || !(await $.session.surfaces()).some(x => x !== 'terminal')) {
      return
    }
    const show = (text: string) => (s.desktop === 'toast' ? $.ui.toast(text, { timeoutMs: 15000 }) : $.ui.log(text))
    if (final.status === 'error') {
      const paused = final.paused ? `; paused after ${MAX_FAILS} failures in a row, /grammar on to try again` : ''
      show(`no check: ${final.error ?? 'unknown'}${paused}`)
      return
    }
    const natural = (await read($, isNatural)) ? final.natural ?? null : null
    if (final.fixes.length > 0 || natural !== null) {
      show(plainText(final.fixes, natural, s.showWhy))
    } else if (s.clean && final.streak !== undefined && s.desktop !== 'band') {
      // The band shows a clean check itself; a transcript line for every clean prompt would be noise there.
      s.desktop === 'toast' ? $.ui.toast(cleanText(final.streak), { timeoutMs: 4000 }) : $.ui.log(cleanText(final.streak))
    }
  } catch {
    // A line that cannot show is not worth failing the check for.
  }
}

/** The part of a prompt to check, or undefined when it is not checked: off, paused, too short, a command, not typed. */
const checkable = async ($: EngineInterface, s: Settings, e: { text: string }) => {
  // Slash commands and hidden prompts are not typed prose. Loose, as older type builds lack both fields.
  const { command, isMeta } = e as { command?: unknown; isMeta?: boolean }
  const text = typedPart(e.text)
  // English needs Latin letters; another language, a list or auto, letters of any script.
  if (command !== undefined || isMeta === true || !lettersFor(s.language).test(text) || wordCount(text) < s.minWords) {
    return undefined
  }
  if (!(await read($, isOn)) || (await read($, fails)) >= MAX_FAILS) {
    return undefined
  }
  return text
}

// How long a Cowork prompt waits for its check before it is sent without one.
const COWORK_TIMEOUT_MS = 15000

/**
 * A Cowork task in the desktop app: no surface, and an entrypoint that names Cowork (remote_cowork for a task in the
 * cloud). claude -p and the SDK have no surface either, but another entrypoint.
 */
const inCowork = async ($: EngineInterface) =>
  (await $.session.surfaces()).length === 0 && /cowork/i.test((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? '')

/** What Claude is told beside a Cowork prompt with mistakes: end the reply with these lines. */
export const replyNote = (lines: string) =>
  `The grammar plugin checked the grammar of the user's message above. Cowork cannot show plugin output, so end your reply with the lines below, on their own after everything else, exactly as written, and say nothing about them:

${lines}

Otherwise answer the message as you would without this note.`

/**
 * Cowork draws no plugin UI at all (no band, toast, transcript line or slash command), so there the prompt waits for
 * its check and Claude is asked to end its reply with the fixes. The note for Claude, or undefined: not Cowork, the
 * cowork setting off, nothing to fix, not in the language checked, or a failed check (the prompt is sent as it is).
 */
const checkForReply = async ($: EngineInterface, s: Settings, e: { text: string }) => {
  if (!s.cowork || !(await inCowork($))) {
    return undefined
  }
  const text = await checkable($, s, e)
  const lists = await loadLists($).catch(() => EMPTY)
  if (text === undefined || compileSkip(lists.skip).some(re => re.test(text))) {
    return undefined
  }
  const ignore = compileIgnore(lists.ignore)
  const natural = await read($, isNatural)
  const r = await ask($, s, text, natural, false, ignore, COWORK_TIMEOUT_MS)
  let reply: ReturnType<typeof parseReply> | undefined
  try {
    reply = r.isAnswered ? parseReply(r.text, fallbackFor(s.language)) : undefined
  } catch {
    reply = undefined
  }
  // Failures still count, so a blocked model stops holding up every prompt after MAX_FAILS.
  await update($, fails, k => (reply === undefined ? k + 1 : 0))
  // In a list, a language not listed is not checked.
  if (reply === undefined || reply === null || keptLanguage(s.language, reply.language) === undefined) {
    return undefined
  }
  const fixes = keepFixes(reply.fixes, text, ignore)
  const better = natural ? usefulNatural(reply.natural, text, fixes, ignore) : null
  return fixes.length === 0 && better === null ? undefined : replyNote(`${DESKTOP_ICONS.logo} ${plainText(fixes, better, s.showWhy)}`)
}

/** Queues a check of a prompt you typed, unless it is not checked or nothing would show it. */
const queue = async ($: EngineInterface, s: Settings, e: { text: string }) => {
  const text = await checkable($, s, e)
  if (text === undefined) {
    return
  }
  // A run that draws nowhere (claude -p, the SDK, Cowork) would never show the fixes: no model call there.
  if ((await $.session.surfaces()).length === 0) {
    return
  }
  const id = await update($, lastId, n => n + 1)
  await update($, checks, all => [{ id, text, status: 'checking' as const, fixes: [] }, ...all].slice(0, MAX_CHECKS))
  // A timer, so the check outlives this dispatch and the prompt is not held up.
  $.clock.after(1, () => {
    const fail = (err: unknown) =>
      update($, checks, all => all.map(c => (c.id === id ? { ...c, status: 'error' as const, error: message(err) } : c)))
    void run($, s, id, text).catch(err => fail(err).catch(() => undefined))
  })
}

const usage = (s: Settings) => `/grammar help: this list, and what is on now
/grammar [on|off]: the ${languageName(s)} check of your prompts
/grammar natural [on|off]: the native-speaker line
/grammar ignore add <words>: never flag these (phrases: separate with commas)
/grammar ignore rm <words>: flag them again
/grammar ignore: the ignore and skip lists, and their files
/grammar stats [7d|30d|since 2026-10-01] [language]: your most frequent mistakes, from the kept fixes
/grammar review [7d|30d|since 2026-10-01] [language]: a summary, then advice on them from ${modelName(s, 'Sonnet')} (one call, from ${REVIEW_FROM} fixes)
/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s, 'Sonnet')} about your writing, with your fixes at hand (one call)
/grammar ask list|clear: what follow-ups remember (the last ${ASK_MEMORY} asks and reviews), or forget it
/grammar ask memory [on|off]: remembering asks for follow-ups
/grammar history [on|off|clear]: keeping fixes for stats and review
More settings (language, model, spelling, minimum words, icons) are under /config.`

/** Adds or removes entries in the global grammar.json, keeping whatever else the file holds. */
const editIgnore = async ($: EngineInterface, op: 'add' | 'rm', entries: string[]) => {
  const path = await globalFile($)
  if (path === undefined) {
    return 'No home folder to keep grammar.json in.'
  }
  let file: Record<string, unknown> = {}
  if (await $.fs.exists(path)) {
    try {
      file = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
      parseLists(JSON.stringify(file))
    } catch (err) {
      return `${path} does not parse (${message(err)}), so it was left as it is. Fix it by hand.`
    }
  }
  const current = parseLists(JSON.stringify(file)).ignore
  const lower = new Set(entries.map(w => w.toLowerCase()))
  const next = op === 'add' ? [...new Set([...current, ...entries])] : current.filter(w => !lower.has(w.toLowerCase()))
  await $.fs.write(path, `${JSON.stringify({ ...file, ignore: next }, null, 2)}\n`)
  const list = entries.map(w => JSON.stringify(w)).join(', ')
  return op === 'add' ? `Never flagged now: ${list}. Kept in ${path}.` : `Flagged again: ${list}. Kept in ${path}.`
}

const showLists = async ($: EngineInterface) => {
  const files = [await globalFile($), await projectFile($).catch(() => undefined)].filter((p): p is string => p !== undefined)
  const lines: string[] = []
  for (const path of [...new Set(files)]) {
    const lists = await readLists($, path)
    const ignore = lists.ignore.length > 0 ? lists.ignore.join(', ') : 'none'
    const skip = lists.skip.length > 0 ? lists.skip.join(', ') : 'none'
    lines.push(`${path}\n  ignore: ${ignore}\n  skip: ${skip}`)
  }
  return lines.join('\n')
}

/** The kept fixes the ignore list leaves, and the history; a message instead when there is no file or it does not parse. */
const loadHistory = async ($: EngineInterface): Promise<{ path: string; h: History; ignore: Ignore } | string> => {
  const path = await historyFile($)
  if (path === undefined) {
    return 'No home folder to keep the history in.'
  }
  try {
    const h = await readHistory($, path)
    const lists = await loadLists($).catch(() => EMPTY)
    return { path, h, ignore: compileIgnore(lists.ignore) }
  } catch (err) {
    return `${path} does not parse (${message(err)}). Fix it by hand, or /grammar history clear to start over.`
  }
}

// API errors that mean this model is not available here (a provider without Sonnet, an org that excludes it). A login
// that fails fails for every model, so it is not one of them.
const UNAVAILABLE: ReadonlySet<ModelApiError> = new Set<ModelApiError>(['model_not_found', 'oauth_org_not_allowed'])

type Request = Omit<Parameters<EngineInterface['model']['complete']>[0], 'model'>

/** One call to Sonnet, else the check's own model when Sonnet is not allowed or not available. Why not, when neither answered. */
const complete = async ($: EngineInterface, s: Settings, request: Request): Promise<{ text: string; model: string } | { refused: string }> => {
  if (s.endpoint !== '') {
    // The endpoint only: nothing goes to Claude's models once one is set.
    const flat = (x: Request['prompt'] | undefined) => (x === undefined ? '' : typeof x === 'string' ? x : x.map(b => b.text).join(''))
    const r = await endpointComplete($, s.endpoint, s.endpointModel, s.endpointKey, { system: flat(request.system), prompt: flat(request.prompt), maxTokens: request.maxTokens ?? 4096, timeoutMs: request.timeoutMs ?? 120000 })
    return r.isAnswered ? { text: r.text.trim(), model: modelName(s, 'sonnet') } : { refused: r.reason }
  }
  let refused = ''
  for (const model of [...new Set(['sonnet', s.model])]) {
    let r: Awaited<ReturnType<typeof $.model.complete>>
    try {
      r = await $.model.complete({ ...request, model })
    } catch (err) {
      // Refused before sending (a model the account may not use): try the next.
      refused = `${model}: ${message(err)}`
      continue
    }
    if (r.isAnswered) {
      return { text: r.text.trim(), model }
    }
    const why = r.reason === 'api-error' ? `api-error (${r.status ?? 'no response'}, ${r.error})` : String(r.reason)
    refused = `${model}: ${why}`
    const unavailable = r.reason === 'api-error' && (r.status === 403 || r.status === 404 || UNAVAILABLE.has(r.error))
    if (!unavailable) {
      break
    }
  }
  return { refused }
}

/** Adds an exchange to what follow-ups remember, when they remember: the newest ASK_MEMORY, oldest first. */
const remember = async ($: EngineInterface, q: string, a: string) => {
  if (!(await read($, askMemory))) {
    return
  }
  await update($, thread, all => [...all, { q: cut(q, MAX_QUESTION), a: cut(a, MAX_ANSWER) }].slice(-ASK_MEMORY))
}

/** The language stats and a review cover (named in the words, else the one set or the most checked), and the words left. */
const forLanguage = (h: History, words: string, s: Settings) => {
  const { lang, rest } = splitLanguage(words, languagesIn(h).map(l => l.lang))
  return { ...pickLanguage(h, lang, s.language), rest }
}

/** A message about words that don't read, with the languages kept when there is more than one to name. */
const withLanguages = (text: string, h: History) => {
  const all = languagesIn(h)
  return all.length > 1 ? `${text} Languages kept: ${all.map(l => l.lang).join(', ')}.` : text
}

/** One model call over the period's grouped fixes: Sonnet, else the check's own model when Sonnet is not allowed. */
const review = async ($: EngineInterface, s: Settings, words: string) => {
  const loaded = await loadHistory($)
  if (typeof loaded === 'string') {
    return loaded
  }
  const now = await $.clock.now()
  const picked = forLanguage(loaded.h, words, s)
  const period = parsePeriod(picked.rest, now)
  if (typeof period === 'string') {
    return withLanguages(period, loaded.h)
  }
  const h = inLanguage(loaded.h, picked.lang)
  const fixes = visible(within(h, period), loaded.ignore)
  if (fixes.length < REVIEW_FROM) {
    const longer = period.before === undefined ? '' : ' Try a longer period.'
    const where = picked.show ? ` in ${picked.lang}` : ''
    return `Not enough to go on yet: ${fixes.length} fixes kept${where} for ${period.label}, the review starts at ${REVIEW_FROM}.${longer} /grammar stats shows them so far.`
  }
  const summary = summaryOf(h, loaded.ignore, period, now, picked.show ? picked.lang : undefined)
  const request = { system: reviewSystem(picked.lang), prompt: reviewInput(fixes), maxTokens: 8000, effort: 'medium' as const, timeoutMs: 180000 }
  const r = await complete($, s, request)
  if ('refused' in r) {
    return `No review: ${r.refused}`
  }
  await remember($, `/grammar review ${words}`.trim(), r.text)
  return shown($, summary, r.text, r.model, await read($, askMemory))
}

/** A review's row text (the summary, the advice, who wrote it), kept so the row can draw it as a panel. */
const shown = async ($: EngineInterface, summary: Summary, advice: string, model: string, followUp: boolean) => {
  const hint = followUp ? '\n/grammar ask <question> follows up on this review.' : ''
  const text = `${summaryText(summary)}\n\n${advice}\n\n(${model}, from ${summary.fixes} fixes)${hint}`
  await update($, reviews, all => [{ text, summary, advice, model, followUp }, ...all].slice(0, 10))
  return text
}

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What follow-ups remember, one exchange per item, oldest first; or that nothing is, or that they don't. */
const askList = async ($: EngineInterface) => {
  if (!(await read($, askMemory))) {
    return 'Ask memory: off. Each /grammar ask starts fresh. /grammar ask memory on remembers asks for follow-ups.'
  }
  const turns = await read($, thread)
  if (turns.length === 0) {
    return `Ask memory: on, nothing remembered yet. Each /grammar ask and /grammar review is remembered for follow-ups, the last ${ASK_MEMORY}.`
  }
  const short = (t: string) => {
    const line = t.replace(/\s+/g, ' ').trim()
    return line.length > 90 ? `${cut(line, 90)}…` : line
  }
  return [
    `Ask memory: on. Follow-ups remember ${plural(turns.length, 'exchange')}, oldest first (the last ${ASK_MEMORY} are kept):`,
    ...turns.map((t, i) => `${i + 1}. ${short(t.q)}\n   ${short(t.a)}`),
    '/grammar ask clear forgets them; /grammar ask memory off stops remembering. Gone when the session ends.',
  ].join('\n')
}

const askCommand = async ($: EngineInterface, s: Settings, words: string) => {
  const w = words.trim()
  const lower = w.toLowerCase()
  if (lower === '' || lower === 'help') {
    const how = `/grammar ask [7d|30d|since 2026-10-01] <question>: ask ${modelName(s, 'Sonnet')} about your writing, with your kept fixes at hand.\n/grammar ask list|clear, /grammar ask memory on|off.`
    return `${how}\n\n${await askList($)}`
  }
  if (lower === 'list') {
    return askList($)
  }
  if (lower === 'clear') {
    const n = (await read($, thread)).length
    await update($, thread, () => [])
    return n === 0 ? 'Nothing remembered, nothing to forget.' : `Forgot ${plural(n, 'exchange')}: the next /grammar ask starts fresh.`
  }
  const memory = /^memory(?:\s+(on|off))?$/.exec(lower)
  if (memory !== null) {
    const want = memory[1] === 'on' ? true : memory[1] === 'off' ? false : !(await read($, askMemory))
    const n = (await read($, thread)).length
    await update($, askMemory, () => want)
    if (!want) {
      await update($, thread, () => [])
    }
    const why = await persist($, 'ask_memory', want)
    return (
      (want
        ? `Ask memory on: follow-ups remember the last ${ASK_MEMORY} asks and reviews of the session. /grammar ask list shows them.`
        : `Ask memory off: each /grammar ask starts fresh${n > 0 ? `, and the ${plural(n, 'remembered exchange')} ${n === 1 ? 'is' : 'are'} forgotten` : ''}.`) +
      sessionOnly(why)
    )
  }
  const now = await $.clock.now()
  const split = splitAsk(w, now)
  if (typeof split === 'string') {
    return split
  }
  if (split.question === '') {
    return 'Ask what? /grammar ask 7d which prepositions do I mix up?'
  }
  const question = cut(split.question, MAX_QUESTION)
  // An unreadable history leaves the question without the kept fixes; the answer says when there are none.
  const loaded = await loadHistory($).catch(() => 'unreadable')
  const fixes = typeof loaded === 'string' ? [] : visible(within(loaded.h, split.period), loaded.ignore)
  const recent = (await read($, checks))
    .flatMap(c => (c.status === 'done' ? c.fixes.map(f => ({ ...f, language: c.language })) : []))
    .slice(0, ASK_RECENT)
  const on = await read($, askMemory)
  const turns = on ? await read($, thread) : []
  const request = {
    system: ASK_SYSTEM,
    prompt: askInput(fixes, split.period.label, recent, turns, question),
    maxTokens: 4000,
    effort: 'low' as const,
    timeoutMs: 120000,
  }
  const r = await complete($, s, request)
  if ('refused' in r) {
    return `No answer: ${r.refused}`
  }
  await remember($, question, r.text)
  const memoryNote = !on
    ? 'memory off, each ask starts fresh'
    : turns.length === 0
      ? 'follow-ups remember this · /grammar ask clear forgets'
      : `remembered ${turns.length} earlier · /grammar ask list, clear`
  const footer = `${r.model}, from ${plural(fixes.length, 'fix', 'fixes')} · ${memoryNote}`
  const text = `${r.text}\n\n(${footer})`
  await update($, asks, all => [{ text, answer: r.text, footer }, ...all].slice(0, 20))
  return text
}

const historyCommand = async ($: EngineInterface, sub: string) => {
  const path = await historyFile($)
  if (sub === 'clear') {
    if (path === undefined || !(await $.fs.exists(path))) {
      return 'Nothing kept, nothing to clear.'
    }
    // In the write queue, so a check that read the file before the clear can't write its fixes back after it.
    await inTurn(() => $.fs.write(path, historyText(EMPTY_HISTORY)))
    return `Cleared: ${path} holds no fixes now.`
  }
  if (sub === 'on' || sub === 'off') {
    const want = sub === 'on'
    await update($, keepsHistory, () => want)
    const why = await persist($, 'history', want)
    const where = path ?? 'grammar-history.json'
    return (
      (want
        ? `History on: each fix is kept in ${where} for /grammar stats and /grammar review.`
        : `History off: no new fixes are kept. What ${where} holds stays; /grammar history clear empties it.`) + sessionOnly(why)
    )
  }
  const loaded = await loadHistory($)
  const on = await read($, keepsHistory)
  if (typeof loaded === 'string') {
    return `History: ${on ? 'on' : 'off'}. ${loaded}`
  }
  const project = await projectFile($).catch(() => undefined)
  const projectAllows = project === undefined || (await readLists($, project)).history
  return [
    `History: ${on ? 'on' : 'off'}${on && !projectAllows ? ', but off in this project (its .claude/grammar.json says "history": false)' : ''}.`,
    `${visible(loaded.h, loaded.ignore).length} fixes kept in ${loaded.path}: the last ${KEEP_DAYS} days, up to ${MAX_ENTRIES}.`,
    '/grammar history on|off switches it; /grammar history clear empties the file.',
  ].join('\n')
}

/** The help's history line: on or off, and how many fixes are kept. */
const historyLine = async ($: EngineInterface) => {
  const on = (await read($, keepsHistory)) ? 'on' : 'off'
  const loaded = await loadHistory($).catch(() => 'unreadable')
  const n = typeof loaded === 'string' ? 0 : visible(loaded.h, loaded.ignore).length
  return `History: ${on}, ${n} fixes kept${n >= REVIEW_FROM ? '' : ` (/grammar review from ${REVIEW_FROM})`}.`
}

export const register: Register = (on, options) => {
  const s = settingsFrom(options)
  const TERMINAL_ICON = s.icons ? NERD_ICONS : PLAIN_ICONS

  on('session.start', async ($, e, next) => {
    const moved = await migrate($).catch(() => ({}) as Record<string, boolean>)
    await update($, isOn, () => moved.enabled ?? s.enabled)
    await update($, isNatural, () => moved.natural ?? s.natural)
    await update($, keepsHistory, () => s.history)
    await update($, askMemory, () => s.askMemory)
    if (s.history) {
      await announceHistory($).catch(() => undefined)
    }
    await $.command.register({
      name: 'grammar',
      description:
        `The ${languageName(s)} check of your prompts: /grammar on|off, /grammar stats, /grammar review, /grammar ask <question>, /grammar ignore add|rm <words>, /grammar help`,
      argumentHint: '[help|on|off|natural|ignore|stats|review|ask|history]',
    })

    return next(e)
  })

  on('command.run', { command: 'grammar' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().split(/\s+/)
    const sub = (rest[0] ?? '').toLowerCase()
    switch (first.toLowerCase()) {
      case 'help':
      case '?': {
        const enabled = await read($, isOn)
        const paused = (await read($, fails)) >= MAX_FAILS
        const check = !enabled ? 'off' : paused ? `paused after ${MAX_FAILS} failures (/grammar on resumes)` : 'on'
        const now = [
          `Check: ${check}. Natural line: ${(await read($, isNatural)) ? 'on' : 'off'}.`,
          `Language: ${s.language === AUTO ? 'auto (each prompt in its own language)' : languagesOf(s.language).length > 1 ? `${s.language} (each prompt in one of them)` : s.language}.`,
          `Model: ${checkerOf(s)}${s.endpoint === '' ? `, effort ${s.effort}` : ''}, spelling ${s.dialect}, at least ${s.minWords} words, up to ${s.maxChars} characters.`,
          await historyLine($),
          (await read($, askMemory))
            ? `Ask memory: on, ${plural((await read($, thread)).length, 'exchange')} remembered (/grammar ask list).`
            : 'Ask memory: off.',
        ]
        return { text: `${now.join('\n')}\n\n${usage(s)}` }
      }
      case 'natural': {
        if (sub !== '' && sub !== 'on' && sub !== 'off') {
          return { text: usage(s) }
        }
        const natural = sub === 'on' ? true : sub === 'off' ? false : !(await read($, isNatural))
        await update($, isNatural, () => natural)
        const why = await persist($, 'natural', natural)
        return {
          text:
            (natural
              ? 'Natural phrasing on: the check also says when a native speaker would put it differently.'
              : 'Natural phrasing off: grammar fixes only.') + sessionOnly(why),
        }
      }
      case 'stats': {
        const loaded = await loadHistory($)
        if (typeof loaded === 'string') {
          return { text: loaded }
        }
        const words = rest.join(' ')
        const now = await $.clock.now()
        const picked = forLanguage(loaded.h, words, s)
        const period = parsePeriod(picked.rest, now)
        if (typeof period === 'string') {
          return { text: withLanguages(period, loaded.h) }
        }
        // The other languages' fixes in the same period, for the pointer to them.
        const others = picked.others
          .map(o => ({ lang: o.lang, fixes: visible(within(inLanguage(loaded.h, o.lang), period), loaded.ignore).length }))
          .filter(o => o.fixes > 0)
        const h = loaded.h.fixes.length + loaded.h.days.length === 0 ? loaded.h : inLanguage(loaded.h, picked.lang)
        const keeping = await read($, keepsHistory)
        const language = picked.show ? picked.lang : undefined
        return { text: statsText(h, loaded.ignore, now, loaded.path, keeping, period, words, modelName(s, 'Sonnet'), language, others) }
      }
      case 'review':
        return { text: await review($, s, rest.join(' ')) }
      case 'ask':
        // The question as typed, line breaks and spacing kept.
        return { text: await askCommand($, s, e.args.trim().slice(first.length)) }
      case 'history': {
        if (sub !== '' && sub !== 'on' && sub !== 'off' && sub !== 'clear') {
          return { text: usage(s) }
        }
        return { text: await historyCommand($, sub) }
      }
      case 'ignore': {
        const words = entriesFrom(rest.slice(1).join(' '))
        if (sub === '' || sub === 'list') {
          return { text: await showLists($) }
        }
        if ((sub === 'add' || sub === 'rm') && words.length > 0) {
          return { text: await editIgnore($, sub, words) }
        }
        return { text: usage(s) }
      }
      case '':
      case 'on':
      case 'off': {
        const want = first === 'on' ? true : first === 'off' ? false : !(await read($, isOn))
        await update($, isOn, () => want)
        if (want) {
          await update($, fails, () => 0)
        }
        const why = await persist($, 'enabled', want)
        return {
          text:
            (want
              ? `${capital(languageName(s))} check on: ${checkerOf(s)} checks each prompt you send${s.language === AUTO ? ', in its own language' : ''}.`
              : `${capital(languageName(s))} check off.`) + sessionOnly(why),
        }
      }
      default:
        return { text: usage(s) }
    }
  })

  // Only prompts with letters (Latin ones for English; checkable tells) can be checked.
  on('prompt.submit', { text: LETTERS }, async ($, e, next) => {
    // A failed check must never stop the prompt.
    const note = await checkForReply($, s, e).catch(() => undefined)
    if (note !== undefined) {
      return next({ ...e, context: [...(e.context ?? []), note] })
    }
    await queue($, s, e).catch(() => undefined)

    return next(e)
  })

  /** Advice or an answer, line by line: numbered lines bold, each "wrong → right" line struck through and fixed. */
  const adviceOf = ({ Box, Text }: ReturnType<EngineInterface['ui']['resolve']>, advice: string) => {
    const fix = (from: string, to: string, key: string) => (
      <Text key={key}>
        <Text color="error" strikethrough>
          {from}
        </Text>
        <Text color="success">{` ${to === '' ? '(drop it)' : to}`}</Text>
      </Text>
    )
    return {
      fix,
      lines: advice.split('\n').map((line, i) => {
        const key = `gr-rule-${i}`
        const example = /^\s*(.+?)\s+→\s+(.*?)\s*$/.exec(line)
        if (/^\s*\d+[.)]\s/.test(line)) {
          return (
            <Text key={key} bold wrap="wrap">
              {line.trim()}
            </Text>
          )
        }
        if (example !== null) {
          return (
            <Box key={key} paddingLeft={3}>
              {fix(example[1] ?? '', example[2] ?? '', `${key}-fix`)}
            </Box>
          )
        }
        return (
          <Text key={key} wrap="wrap">
            {line.trim() === '' ? ' ' : line.trim()}
          </Text>
        )
      }),
    }
  }

  // A review's row: the summary as a card, then the advice with each example drawn like a fix. An ask's row: the answer drawn the same way.
  on('ui.render', { component: 'CommandOutput', props: { command: 'grammar' } }, async ($, e, next) => {
    const row = await next(e)
    const text = e.props.text.trim()
    const matches = (x: { text: string }) => text === x.text.trim() || text.endsWith(x.text.trim())
    const a = (await read($, asks)).find(matches)
    if (a !== undefined) {
      const ui = $.ui.resolve(e)
      const { Box, Text } = ui
      return (
        <Box key="grammar-ask" flexDirection="column">
          <Box key="gr-answer" flexDirection="column">
            {adviceOf(ui, a.answer).lines}
          </Box>
          <Box key="gr-footer" marginTop={1}>
            <Text dimColor wrap="wrap">
              {a.footer}
            </Text>
          </Box>
        </Box>
      )
    }
    const r = (await read($, reviews)).find(matches)
    if (r === undefined) {
      return row
    }
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const m = r.summary
    const BAR = 15
    const [full, empty] = s.icons ? ['█', '░'] : ['#', '.']
    const most = Math.max(1, ...m.kinds.map(k => k.n))
    const width = Math.max(0, ...m.kinds.slice(0, 3).map(k => k.kind.length))
    const { fix, lines: advice } = adviceOf(ui, r.advice)
    const card = (
      <Box key="gr-panel" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} alignSelf="flex-start">
        <Text key="gr-p-title">
          <Text bold>Grammar review</Text>
          <Text dimColor>{` · ${m.language === undefined ? '' : `${m.language} · `}${m.label} (${m.range})`}</Text>
        </Text>
        <Text key="gr-p-counts">{`${m.checked} prompts · ${Math.round((100 * m.withFixes) / Math.max(1, m.checked))}% with a fix · ${m.fixes} fixes`}</Text>
        {m.trend !== undefined && (
          <Text key="gr-p-trend" color={m.trend.fewer === true ? 'success' : m.trend.fewer === false ? 'warning' : undefined}>
            {`${m.trend.fewer === true ? '↓' : m.trend.fewer === false ? '↑' : '='} ${m.trend.text}`}
          </Text>
        )}
        <Text key="gr-p-gap1"> </Text>
        {m.kinds.slice(0, 3).map(k => {
          const n = Math.max(1, Math.round((BAR * k.n) / most))
          return (
            <Text key={`gr-p-k-${k.kind}`}>
              {`${k.kind.padEnd(width)} `}
              <Text color="suggestion">{full.repeat(n)}</Text>
              <Text dimColor>{empty.repeat(BAR - n)}</Text>
              {`  ${Math.round(k.share * 100)}%`}
            </Text>
          )
        })}
        {m.top !== undefined && <Text key="gr-p-gap2"> </Text>}
        {m.top !== undefined && (
          <Text key="gr-p-top">
            <Text dimColor>{'most repeated  '}</Text>
            {fix(m.top.from, m.top.to, 'gr-p-top-fix')}
            <Text dimColor>{`  ×${m.top.count}`}</Text>
          </Text>
        )}
      </Box>
    )
    return (
      <Box key="grammar-review" flexDirection="column">
        {card}
        <Box key="gr-advice" flexDirection="column" marginTop={1}>
          {advice}
        </Box>
        <Box key="gr-footer">
          <Text dimColor>{`${r.model}, from ${m.fixes} fixes${r.followUp === true ? ' · /grammar ask <question> follows up' : ''}`}</Text>
        </Box>
      </Box>
    )
  })

  /** The error line, fixes line and native-speaker line of a check, as the row under the prompt and the band draw them. */
  const linesOf = ({ Box, Text }: ReturnType<EngineInterface['ui']['resolve']>, c: GrammarCheck, natural: string | null, wide: boolean) => {
    const ICON = wide ? DESKTOP_ICONS : TERMINAL_ICON
    const lines: RenderNode[] = []
    if (c.status === 'error') {
      const paused = c.paused ? `; paused after ${MAX_FAILS} failures in a row, /grammar on to try again` : ''
      lines.push(
        <Box key="gr-error">
          <Text dimColor wrap="truncate-end">
            {`${ICON.error} no grammar check: ${c.error ?? 'unknown'}${paused}`}
          </Text>
        </Box>,
      )
    }
    const fix = (f: GrammarCheck['fixes'][number], i: number) => (
      <Text key={`gr-f${i}`}>
        {i > 0 && !wide && <Text dimColor>{'  · '}</Text>}
        <Text color="error" strikethrough>
          {f.from}
        </Text>
        {f.to !== '' && <Text color="success">{` ${f.to}`}</Text>}
        {s.showWhy && f.why !== '' && <Text dimColor>{` ${f.why}`}</Text>}
      </Text>
    )
    if (c.fixes.length > 0 && wide) {
      // One row per fix, the icon on the first row only.
      lines.push(
        <Box key="gr-fixes" flexDirection="column">
          {c.fixes.map((f, i) => (
            <Box key={`gr-row${i}`}>
              <Box width={2} flexShrink={0}>
                <Text color="suggestion">{i === 0 ? ICON.logo : ''}</Text>
              </Box>
              <Text wrap="wrap">{fix(f, i)}</Text>
            </Box>
          ))}
        </Box>,
      )
    } else if (c.fixes.length > 0) {
      lines.push(
        <Box key="gr-fixes">
          <Text wrap="wrap">
            <Text color="suggestion">{`${ICON.logo} `}</Text>
            {c.fixes.map(fix)}
          </Text>
        </Box>,
      )
    }
    if (natural !== null) {
      lines.push(
        <Box key="gr-natural">
          <Text wrap="wrap">
            <Text color="suggestion">{`${ICON.natural} `}</Text>
            <Text italic dimColor>
              {natural}
            </Text>
          </Text>
        </Box>,
      )
    }
    return lines
  }

  /** A clean prompt's row: a green check before it, and under it how many clean prompts in a row from STREAK_FROM. */
  const cleanRow = ({ Box, Text }: ReturnType<EngineInterface['ui']['resolve']>, row: RenderNode, n: number) => (
    <Box key="grammar" flexDirection="column">
      <Box key="gr-clean" flexDirection="row">
        {/* The engine's row opens with a blank line: the check goes on the line after it, next to the prompt. */}
        <Box key="gr-ok" width={2} flexShrink={0} marginTop={1}>
          <Text color="success">{CHECK}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {row}
        </Box>
      </Box>
      {n >= STREAK_FROM && (
        <Box key="gr-streak" paddingLeft={4}>
          <Text color="success" dimColor>{`${n} in a row`}</Text>
        </Box>
      )}
    </Box>
  )

  // Under each prompt you typed: its fixes, then the natural rewrite. A check before it when clean. Nothing while checking.
  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    const row = await next(e)
    const c = checkFor(await read($, checks), e.props.text)
    if (c === undefined || c.status === 'checking') {
      return row
    }
    const natural = (await read($, isNatural)) ? c.natural ?? null : null
    if (c.status === 'done' && c.fixes.length === 0 && natural === null) {
      return s.clean && c.streak !== undefined ? cleanRow($.ui.resolve(e), row, c.streak) : row
    }

    const ui = $.ui.resolve(e)
    const { Box } = ui
    const lines = linesOf(ui, c, natural, e.surface !== 'terminal')

    return (
      <Box key="grammar" flexDirection="column">
        {row}
        <Box flexDirection="column" paddingLeft={2}>
          {lines}
        </Box>
      </Box>
    )
  })

  // The desktop app doesn't draw the row above, so there the newest check shows in a band above the prompt. A short
  // green line when clean (and the clean setting is on). Nothing while checking.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || s.desktop !== 'band' || e.props.hasSurvey) {
      return next(e)
    }
    const c = (await read($, checks))[0]
    if (c === undefined || c.status === 'checking' || (await read($, hiddenId)) === c.id) {
      return next(e)
    }
    const natural = (await read($, isNatural)) ? c.natural ?? null : null
    const clean = c.status === 'done' && c.fixes.length === 0 && natural === null
    if (clean && (!s.clean || c.streak === undefined)) {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const n = c.streak ?? 0
    return (
      <Box key="grammar-band" flexDirection="row">
        <Box key="gr-band-lines" flexDirection="column" flexGrow={1}>
          {clean ? (
            <Box key="gr-ok">
              <Text>
                <Text color="success">{`${CHECK} No mistakes`}</Text>
                {n >= STREAK_FROM && <Text dimColor>{` · ${n} in a row`}</Text>}
              </Text>
            </Box>
          ) : (
            linesOf(ui, c, natural, true)
          )}
        </Box>
        <Button key="hide" label="Hide" onPress={() => update($, hiddenId, () => c.id)} />
      </Box>
    )
  })
}
