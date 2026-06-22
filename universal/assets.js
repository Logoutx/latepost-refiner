// ===== Runtime asset resolution (source checkout vs compiled binary) =====
// The web server needs web/index.html, and the pipeline's summary/timeline/logic agents Read
// claude-code-skill/references/*.md (via skillDir). In a source checkout those live on disk;
// in a `bun build --compile` binary there is no such directory, so we fall back to copies
// embedded at build time (build/embed-assets.mjs → universal/embedded-assets.js).
//
// Strategy: prefer on-disk (so a checkout picks up live edits and never goes stale), fall back
// to embedded. The embedded module is absent in a plain checkout — imported dynamically so its
// absence is a no-op, and bundled into the binary because the specifier is a static string.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DISK_INDEX = path.join(here, 'web', 'index.html')
const DISK_SKILL_DIR = path.resolve(here, '..', 'claude-code-skill')

let EMBEDDED = null
try { EMBEDDED = (await import('./embedded-assets.js')).default } catch { /* source checkout: none embedded */ }

// HTML for the browser UI — disk first, embedded fallback.
export function getIndexHtml() {
  try { return fs.readFileSync(DISK_INDEX, 'utf8') } catch { /* fall through */ }
  if (EMBEDDED && EMBEDDED.indexHtml) return EMBEDDED.indexHtml
  throw new Error('index.html 找不到（磁盘和内置副本都没有）')
}

// A directory that contains references/ for the Read tool. In a checkout that's the repo's
// claude-code-skill/; in a binary we materialize the embedded references to a temp dir once
// and hand back that path, so the existing file-sandbox + Read flow works unchanged.
let materialized = null
export function resolveSkillDir() {
  if (fs.existsSync(path.join(DISK_SKILL_DIR, 'references', 'deliverables.md'))) return DISK_SKILL_DIR
  if (materialized) return materialized
  if (EMBEDDED && EMBEDDED.references) {
    const dir = path.join(os.tmpdir(), 'latepost-refiner-skill')
    const refDir = path.join(dir, 'references')
    fs.mkdirSync(refDir, { recursive: true })
    for (const [name, content] of Object.entries(EMBEDDED.references)) {
      fs.writeFileSync(path.join(refDir, name), content, 'utf8')
    }
    materialized = dir
    return dir
  }
  return DISK_SKILL_DIR // last resort; downstream warns if references are missing
}
