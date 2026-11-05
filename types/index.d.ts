// `why` is '' when the show_why setting is off. `kind` is what the fix corrects, asked for while the history is on.
export type GrammarFix = { from: string; to: string; why: string; kind?: string }
// `language` is the text's, named in English ("French").
export type GrammarReply = { fixes: GrammarFix[]; natural: string | null; language: string }
export type GrammarCheck = {
  id: number
  // The prompt as typed, trimmed.
  text: string
  status: 'checking' | 'done' | 'error'
  fixes: GrammarFix[]
  // How a native speaker would say it, when the phrasing is clearly off.
  natural?: string | null
  error?: string
  // This failure paused the checks: too many in a row.
  paused?: boolean
  // Clean prompts in a row, this one included; set only on a clean check.
  streak?: number
  // The language it was checked in, named in English ("French"); set on a done check.
  language?: string
}

/** The figures at the top of a review (hooks/history.ts builds them as its Summary). */
export type GrammarSummary = {
  // The language it covers, when worth naming.
  language?: string
  label: string
  range: string
  checked: number
  withFixes: number
  fixes: number
  trend?: { recent: number; before: number; fewer: boolean | null; text: string }
  kinds: { kind: string; n: number; share: number }[]
  top?: { from: string; to: string; kind: string; why: string; count: number }
}
/** A review shown this session: the row's text, and what the panel above the advice draws from. */
export type GrammarReview = { text: string; summary: GrammarSummary; advice: string; model: string; followUp?: boolean }
/** An answer to /grammar ask shown this session: the row's text, the answer and the footer under it. */
export type GrammarAsk = { text: string; answer: string; footer: string }
/** One exchange /grammar ask remembers for follow-ups: the question (or the review command) and the answer. */
export type GrammarTurn = { q: string; a: string }

declare module 'claude-code' {
  interface PluginState {
    grammar: {
      grammarOn: boolean
      grammarNatural: boolean
      // Fixes are kept in grammar-history.json for /grammar stats and /grammar review.
      grammarHistory: boolean
      // Reviews shown this session, newest first, so their rows can draw the panel.
      grammarReviews: GrammarReview[]
      // Answers to /grammar ask shown this session, newest first, so their rows can draw them.
      grammarAsks: GrammarAsk[]
      // What /grammar ask remembers for follow-ups, oldest first; /grammar ask clear empties it.
      grammarThread: GrammarTurn[]
      // Follow-ups remember earlier asks and reviews (the ask_memory setting).
      grammarAskMemory: boolean
      grammarChecks: GrammarCheck[]
      grammarLastId: number
      // Failed checks in a row; at MAX_FAILS the checks pause until /grammar on.
      grammarFails: number
      // The id of the check whose band was hidden in the desktop app.
      grammarHiddenId: number
      // Clean checks in a row this session; a check with a fix resets it.
      grammarStreak: number
    }
  }
}
