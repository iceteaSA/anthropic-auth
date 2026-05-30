#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const DEFAULT_DB = '~/.local/share/opencode/opencode.db'
const MILLION = 1_000_000

const MODEL_PRICES = [
  {
    match: /opus-4-[8765]/i,
    label: 'Claude Opus 4.5/4.6/4.7/4.8',
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
  },
  {
    match: /opus-4([^-]|$)/i,
    label: 'Claude Opus 4/4.1',
    input: 15,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
    output: 75,
  },
  {
    match: /sonnet-(3-7|4)/i,
    label: 'Claude Sonnet 3.7/4/4.5/4.6',
    input: 3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
    output: 15,
  },
  {
    match: /haiku-4-5/i,
    label: 'Claude Haiku 4.5',
    input: 1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
    output: 5,
  },
  {
    match: /haiku-3-5/i,
    label: 'Claude Haiku 3.5',
    input: 0.8,
    cacheWrite5m: 1,
    cacheWrite1h: 1.6,
    cacheRead: 0.08,
    output: 4,
  },
  {
    match: /haiku-3/i,
    label: 'Claude Haiku 3',
    input: 0.25,
    cacheWrite5m: 0.3,
    cacheWrite1h: 0.5,
    cacheRead: 0.03,
    output: 1.25,
  },
]

function usage() {
  console.log(`Usage: node scripts/analyze-cache-usage.mjs [options]

Options:
  --db <path>                 SQLite DB path (default: ${DEFAULT_DB})
  --session <id>              Restrict to one OpenCode session
  --days <n>                  Restrict to assistant requests started in last n days
  --idle-threshold-min <n>    5m cache expiry threshold (default: 5)
  --json                      Emit JSON instead of text
  --help                      Show this help

Examples:
  node scripts/analyze-cache-usage.mjs --session ses_... --days 4
  node scripts/analyze-cache-usage.mjs --days 7 --json`)
}

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    session: null,
    days: null,
    idleThresholdMin: 5,
    json: false,
  }

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(`Missing value for ${arg}`)
      return value
    }

    if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    } else if (arg === '--db') {
      args.db = next()
    } else if (arg === '--session') {
      args.session = next()
    } else if (arg === '--days') {
      args.days = Number(next())
    } else if (arg === '--idle-threshold-min') {
      args.idleThresholdMin = Number(next())
    } else if (arg === '--json') {
      args.json = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (args.days != null && (!Number.isFinite(args.days) || args.days <= 0)) {
    throw new Error('--days must be a positive number')
  }
  if (!Number.isFinite(args.idleThresholdMin) || args.idleThresholdMin <= 0) {
    throw new Error('--idle-threshold-min must be a positive number')
  }
  return args
}

function expandPath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runSql(dbPath, query) {
  const output = execFileSync('sqlite3', ['-json', dbPath, query], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  }).trim()
  return output ? JSON.parse(output) : []
}

function priceForModel(modelId) {
  const found = MODEL_PRICES.find((price) => price.match.test(modelId || ''))
  if (found) return found
  // Safe default for this repo/user's current Claude sessions; output marks it as inferred.
  return {
    ...MODEL_PRICES[0],
    label: `${MODEL_PRICES[0].label} (default; model not recognized)`,
  }
}

function dollars(tokens, dollarsPerMillionTokens) {
  return (tokens / MILLION) * dollarsPerMillionTokens
}

function emptyCost() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
}

function computeCosts(row, idleThresholdMs) {
  const price = priceForModel(row.model_id)
  const input = row.input_tokens
  const cacheRead = row.cache_read_tokens
  const cacheWrite = row.cache_write_tokens
  const output = row.output_tokens
  const promptTotal = input + cacheRead + cacheWrite
  const idleExpired5m = row.idle_ms > idleThresholdMs
  const idleExpired1h = row.idle_ms > 60 * 60 * 1000

  const noCache = emptyCost()
  noCache.input = dollars(promptTotal, price.input)
  noCache.output = dollars(output, price.output)
  noCache.total = noCache.input + noCache.output

  const fiveMinute = emptyCost()
  fiveMinute.input = dollars(input, price.input)
  fiveMinute.output = dollars(output, price.output)
  if (idleExpired5m) {
    fiveMinute.cacheWrite = dollars(cacheRead + cacheWrite, price.cacheWrite5m)
  } else {
    fiveMinute.cacheRead = dollars(cacheRead, price.cacheRead)
    fiveMinute.cacheWrite = dollars(cacheWrite, price.cacheWrite5m)
  }
  fiveMinute.total =
    fiveMinute.input +
    fiveMinute.cacheRead +
    fiveMinute.cacheWrite +
    fiveMinute.output

  const oneHour = emptyCost()
  oneHour.input = dollars(input, price.input)
  oneHour.output = dollars(output, price.output)
  if (idleExpired1h) {
    oneHour.cacheWrite = dollars(cacheRead + cacheWrite, price.cacheWrite1h)
  } else {
    oneHour.cacheRead = dollars(cacheRead, price.cacheRead)
    oneHour.cacheWrite = dollars(cacheWrite, price.cacheWrite1h)
  }
  oneHour.total =
    oneHour.input + oneHour.cacheRead + oneHour.cacheWrite + oneHour.output

  return { price, noCache, fiveMinute, oneHour }
}

function formatMoney(value) {
  return `$${value.toFixed(4)}`
}

function formatInt(value) {
  return Math.round(value).toLocaleString('en-US')
}

function summarize(rows, idleThresholdMs) {
  const summary = {
    turns: rows.length,
    idleOverThreshold: 0,
    idleOver1h: 0,
    tokens: {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      promptTotal: 0,
    },
    costs: {
      noCache: emptyCost(),
      fiveMinute: emptyCost(),
      oneHour: emptyCost(),
    },
    byModel: {},
    buckets: {},
  }

  for (const row of rows) {
    const costs = computeCosts(row, idleThresholdMs)
    const bucket =
      row.idle_ms <= idleThresholdMs
        ? '<=5m'
        : row.idle_ms <= 60 * 60 * 1000
          ? '5m-1h'
          : '>1h'
    const modelKey = row.model_id || '(unknown)'

    if (row.idle_ms > idleThresholdMs) summary.idleOverThreshold++
    if (row.idle_ms > 60 * 60 * 1000) summary.idleOver1h++

    summary.tokens.input += row.input_tokens
    summary.tokens.cacheRead += row.cache_read_tokens
    summary.tokens.cacheWrite += row.cache_write_tokens
    summary.tokens.output += row.output_tokens
    summary.tokens.promptTotal +=
      row.input_tokens + row.cache_read_tokens + row.cache_write_tokens

    for (const scenario of ['noCache', 'fiveMinute', 'oneHour']) {
      for (const key of [
        'input',
        'cacheRead',
        'cacheWrite',
        'output',
        'total',
      ]) {
        summary.costs[scenario][key] += costs[scenario][key]
      }
    }

    summary.byModel[modelKey] ??= { label: costs.price.label, turns: 0 }
    summary.byModel[modelKey].turns++

    summary.buckets[bucket] ??= {
      turns: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTotal: 0,
    }
    summary.buckets[bucket].turns++
    summary.buckets[bucket].cacheRead += row.cache_read_tokens
    summary.buckets[bucket].cacheWrite += row.cache_write_tokens
    summary.buckets[bucket].promptTotal +=
      row.input_tokens + row.cache_read_tokens + row.cache_write_tokens
  }

  summary.deltas = {
    fiveMinuteVsNoCache:
      summary.costs.fiveMinute.total - summary.costs.noCache.total,
    oneHourVsNoCache: summary.costs.oneHour.total - summary.costs.noCache.total,
    oneHourVsFiveMinute:
      summary.costs.oneHour.total - summary.costs.fiveMinute.total,
  }

  return summary
}

function buildQuery(args) {
  const filters = [
    "next2_role = 'assistant'",
    "role = 'assistant'",
    "next_role = 'user'",
    '(next_created - time_updated) >= 0',
  ]
  if (args.session) filters.push(`session_id = ${sqlString(args.session)}`)
  if (args.days != null)
    filters.push(
      `next2_created >= (strftime('%s','now') - ${Number(args.days)} * 86400) * 1000`,
    )

  return `
WITH ordered AS (
  SELECT
    id,
    session_id,
    time_created,
    time_updated,
    data,
    json_extract(data,'$.role') AS role,
    lead(id) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next_id,
    lead(time_created) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next_created,
    lead(json_extract(data,'$.role')) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next_role,
    lead(id,2) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next2_id,
    lead(time_created,2) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next2_created,
    lead(json_extract(data,'$.role'),2) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next2_role,
    lead(data,2) OVER (PARTITION BY session_id ORDER BY time_created, id) AS next2_data
  FROM message
  ${args.session ? `WHERE session_id = ${sqlString(args.session)}` : ''}
)
SELECT
  session_id,
  id AS previous_assistant_id,
  time_updated AS previous_assistant_end,
  next_id AS user_id,
  next_created AS user_start,
  next2_id AS assistant_id,
  next2_created AS assistant_start,
  next_created - time_updated AS idle_ms,
  COALESCE(json_extract(next2_data,'$.modelID'),'') AS model_id,
  COALESCE(json_extract(next2_data,'$.providerID'),'') AS provider_id,
  COALESCE(json_extract(next2_data,'$.tokens.input'),0) AS input_tokens,
  COALESCE(json_extract(next2_data,'$.tokens.cache.read'),0) AS cache_read_tokens,
  COALESCE(json_extract(next2_data,'$.tokens.cache.write'),0) AS cache_write_tokens,
  COALESCE(json_extract(next2_data,'$.tokens.output'),0) AS output_tokens
FROM ordered
WHERE ${filters.join(' AND ')}
ORDER BY assistant_start, assistant_id;
`
}

function printSummary(args, summary) {
  console.log('OpenCode Claude cache usage estimate')
  console.log('====================================')
  console.log(`DB: ${expandPath(args.db)}`)
  if (args.session) console.log(`Session: ${args.session}`)
  if (args.days != null) console.log(`Window: last ${args.days} days`)
  console.log(`5m expiry threshold: ${args.idleThresholdMin} minutes`)
  console.log(
    'Assumption: observed DB cache usage is the 1h-cache run; 5m/no-cache are counterfactual estimates from the same prompt/output token counts.',
  )
  console.log('')

  console.log(`Turns analyzed: ${formatInt(summary.turns)}`)
  console.log(
    `Idle > threshold: ${formatInt(summary.idleOverThreshold)} (${summary.turns ? ((summary.idleOverThreshold / summary.turns) * 100).toFixed(1) : '0.0'}%)`,
  )
  console.log(
    `Idle > 1h: ${formatInt(summary.idleOver1h)} (${summary.turns ? ((summary.idleOver1h / summary.turns) * 100).toFixed(1) : '0.0'}%)`,
  )
  console.log('')

  console.log('Tokens:')
  console.log(`  prompt total: ${formatInt(summary.tokens.promptTotal)}`)
  console.log(`  input:        ${formatInt(summary.tokens.input)}`)
  console.log(`  cache read:   ${formatInt(summary.tokens.cacheRead)}`)
  console.log(`  cache write:  ${formatInt(summary.tokens.cacheWrite)}`)
  console.log(`  output:       ${formatInt(summary.tokens.output)}`)
  console.log('')

  console.log('Gap buckets:')
  for (const key of ['<=5m', '5m-1h', '>1h']) {
    const bucket = summary.buckets[key] ?? {
      turns: 0,
      cacheRead: 0,
      cacheWrite: 0,
      promptTotal: 0,
    }
    console.log(
      `  ${key.padEnd(5)} turns=${formatInt(bucket.turns).padStart(5)} cache_read=${formatInt(bucket.cacheRead).padStart(12)} cache_write=${formatInt(bucket.cacheWrite).padStart(12)} prompt=${formatInt(bucket.promptTotal).padStart(12)}`,
    )
  }
  console.log('')

  console.log('Estimated cost:')
  for (const [label, cost] of [
    ['no cache', summary.costs.noCache],
    ['5m cache', summary.costs.fiveMinute],
    ['1h cache', summary.costs.oneHour],
  ]) {
    console.log(
      `  ${label.padEnd(8)} total=${formatMoney(cost.total).padStart(10)} input=${formatMoney(cost.input).padStart(9)} read=${formatMoney(cost.cacheRead).padStart(9)} write=${formatMoney(cost.cacheWrite).padStart(9)} output=${formatMoney(cost.output).padStart(9)}`,
    )
  }
  console.log('')

  console.log('Deltas:')
  console.log(
    `  5m cache vs no cache: ${formatMoney(summary.deltas.fiveMinuteVsNoCache)}`,
  )
  console.log(
    `  1h cache vs no cache: ${formatMoney(summary.deltas.oneHourVsNoCache)}`,
  )
  console.log(
    `  1h cache vs 5m cache: ${formatMoney(summary.deltas.oneHourVsFiveMinute)}`,
  )
  console.log('')

  console.log('Models/pricing:')
  for (const [model, info] of Object.entries(summary.byModel)) {
    console.log(`  ${model}: ${formatInt(info.turns)} turns, ${info.label}`)
  }
}

function main() {
  const args = parseArgs(process.argv)
  const dbPath = expandPath(args.db)
  if (!existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`)

  const rows = runSql(dbPath, buildQuery(args))
  const summary = summarize(rows, args.idleThresholdMin * 60 * 1000)

  if (args.json) {
    console.log(
      JSON.stringify({ args: { ...args, db: dbPath }, summary }, null, 2),
    )
  } else {
    printSummary(args, summary)
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
