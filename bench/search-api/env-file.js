// ===== env-file loader (bench only) =====
// Loads KEY=VALUE lines from a plain env file into process.env, so the owner can keep search-API keys in a
// keys.env inside the research vault (passed via --env-file) instead of letting values pass through chat.
//
// Rules:
//   • blank lines and #-comment lines are ignored
//   • VALUE may be wrapped in matching single or double quotes (stripped); an unquoted trailing " # …" is dropped
//   • a key is set ONLY if not already present in env (shell / earlier source wins)
//
// SECURITY: this loader NEVER returns, logs, or echoes any VALUE (not even truncated). It returns counts and,
// for malformed non-empty lines, their LINE NUMBERS only — never the line content. Callers must likewise print
// only counts / line numbers, never key values.

import fs from 'node:fs'

// Parse env-file text. Returns { loaded, skipped, badLines } — numbers + 1-based line numbers only, no values.
export function parseEnvFile(text, env = process.env) {
  let loaded = 0
  let skipped = 0
  const badLines = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) { badLines.push(i + 1); continue } // line NUMBER only — content is never captured or surfaced
    const key = m[1]
    let value = m[2].trim()
    const quoted = value.match(/^(['"])([\s\S]*)\1$/)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '').trim() // drop an inline comment on an unquoted value
    if (env[key] !== undefined) { skipped += 1; continue } // only if not already set
    env[key] = value
    loaded += 1
  }
  return { loaded, skipped, badLines }
}

// Read + parse a file. Throws only for I/O (missing/unreadable path); parse issues surface as badLines.
export function loadEnvFile(filePath, env = process.env) {
  return parseEnvFile(fs.readFileSync(filePath, 'utf8'), env)
}
