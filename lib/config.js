/**
 * dsh-knowledge-lite · where the library lives
 *
 * The note root is user-configurable, so the setting cannot live inside the
 * library itself (moving the library would move the setting with it). It goes
 * to a fixed path next to the other E: tooling, outside DSH_HOME so it survives
 * profile resets and can be found by hand.
 *
 * Resolution order: config file → DEFAULT_ROOT (and the file is written on
 * first use so the UI can show a real, editable value).
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_ROOT = 'E:/dsh-kb'
export const CONFIG_PATH = 'E:/dsh-tools/dsh-knowledge-lite.json'
const NOTES_SUBDIR = 'notes'

/** @returns {{root: string, savedAt?: string}} */
export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed && typeof parsed.root === 'string' && parsed.root.trim() !== '') {
      return { root: parsed.root.trim(), savedAt: parsed.savedAt }
    }
  } catch {
    /* missing or corrupt config is not an error — fall back to the default */
  }
  return { root: DEFAULT_ROOT }
}

export async function writeConfig(root) {
  await mkdir('E:/dsh-tools', { recursive: true })
  const payload = { root, savedAt: new Date().toISOString() }
  await writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/**
 * Copy every note file from one root to another, keeping ids (file names).
 * Best-effort per file: one unreadable note must not abort the whole move.
 * @returns {{copied: number, skipped: number, from: string, to: string}}
 */
export async function migrateLibrary(fromRoot, toRoot) {
  const fromDir = join(fromRoot, NOTES_SUBDIR)
  const toDir = join(toRoot, NOTES_SUBDIR)
  let names = []
  try {
    names = await readdir(fromDir)
  } catch {
    return { copied: 0, skipped: 0, from: fromRoot, to: toRoot }
  }
  await mkdir(toDir, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      await copyFile(join(fromDir, name), join(toDir, name))
      copied += 1
    } catch {
      skipped += 1
    }
  }
  return { copied, skipped, from: fromRoot, to: toRoot }
}
