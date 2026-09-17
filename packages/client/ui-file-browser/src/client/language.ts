/**
 * File-extension to syntax-highlighting language hints, re-exported from the
 * package that owns the highlighter.
 *
 * The table itself lives in `ui-primitives` beside the shiki singleton whose
 * aliases it names; this module keeps the browser's import site stable without
 * carrying a second copy that would have to agree with it forever.
 * @module @deepseek-ai/dsh-client-ui-file-browser/language
 */

export { languageOfPath } from '@deepseek-ai/dsh-client-ui-primitives'
