#!/usr/bin/env node
// instinct: unofficial WhatsApp CLI built on Baileys. Talks to a single fixed contact.
import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  getContentType,
  normalizeMessageContent,
  useMultiFileAuthState,
} from 'baileys'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

const TARGET_PN = '16508702892@s.whatsapp.net'
const TARGET_LABEL = '+1 (650) 870-2892'
const DATA_DIR = process.env.INSTINCT_HOME || path.join(os.homedir(), '.instinct')
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const STORE_FILE = path.join(DATA_DIR, 'messages.json')
const STORE_MAX = 2000
let shuttingDown = false

fs.mkdirSync(DATA_DIR, { recursive: true })

// libsignal dumps whole session objects (private keys included) through console.*,
// so the CLI writes its own output directly to stdout/stderr and mutes console.
const out = (s = '') => process.stdout.write(s + '\n')
const err = (s = '') => process.stderr.write(s + '\n')
for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[m] = () => {}

// ---------- message store ----------

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch {
    return []
  }
}

function saveStore(messages) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(messages.slice(-STORE_MAX), null, 2))
}

function messageText(msg) {
  const content = normalizeMessageContent(msg.message)
  if (!content) return null
  const type = getContentType(content)
  const m = content[type]
  switch (type) {
    case 'conversation':
      return m
    case 'extendedTextMessage':
      return m.text
    case 'imageMessage':
    case 'videoMessage':
    case 'documentMessage':
      return `[${type.replace('Message', '')}]${m.caption ? ' ' + m.caption : ''}`
    case 'audioMessage':
      return '[audio]'
    case 'stickerMessage':
      return '[sticker]'
    case 'reactionMessage':
      return m.text ? `[reaction ${m.text}]` : null
    case 'protocolMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
      return null
    default:
      return `[${type}]`
  }
}

function toRecord(msg) {
  const text = messageText(msg)
  if (text == null) return null
  return {
    id: msg.key.id,
    fromMe: !!msg.key.fromMe,
    timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    text,
  }
}

function addMessages(msgs, isTarget) {
  const store = loadStore()
  const seen = new Set(store.map((m) => m.id))
  const added = []
  for (const msg of msgs) {
    if (!isTarget(msg.key)) continue
    const rec = toRecord(msg)
    if (!rec || seen.has(rec.id)) continue
    seen.add(rec.id)
    store.push(rec)
    added.push(rec)
  }
  if (added.length) {
    store.sort((a, b) => a.timestamp - b.timestamp)
    saveStore(store)
  }
  return added
}

function formatRecord(rec, { color = false } = {}) {
  const d = new Date(rec.timestamp * 1000)
  const when = d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
  const who = rec.fromMe ? 'me' : 'them'
  if (!color) return `[${when}] ${who}: ${rec.text}`
  const whoColored = rec.fromMe ? `\x1b[36m${who}\x1b[0m` : `\x1b[32m${who}\x1b[0m`
  return `\x1b[2m[${when}]\x1b[0m ${whoColored}: ${rec.text}`
}

// ---------- connection ----------

/**
 * Connects to WhatsApp, showing a QR code if not yet linked, and resolves once
 * the connection is open and offline notifications have been received.
 * `onMessages` gets every newly stored message for the target contact;
 * `onSocket` gets each new socket, including ones created by reconnects.
 */
let waVersion
async function connect({ onMessages, onSocket, onStatus = err, persistent = false } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  // the WA Web version bundled with Baileys goes stale and phones refuse to pair with it
  waVersion ??= (await fetchLatestWaWebVersion().catch(() => ({}))).version
  const targetJids = new Set([TARGET_PN])
  const isTarget = (key) =>
    targetJids.has(key.remoteJid) || (key.remoteJidAlt && targetJids.has(key.remoteJidAlt))

  return new Promise((resolve, reject) => {
    let settled = false
    const sock = makeWASocket({
      auth: state,
      version: waVersion,
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
    })
    onSocket?.(sock)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications } = update
      if (qr) {
        err('\nScan this QR code from WhatsApp > Linked devices > Link a device:\n')
        qrcode.generate(qr, { small: true }, (code) => err(code))
      }
      if (connection === 'open') {
        const lid = await sock.signalRepository.lidMapping.getLIDForPN(TARGET_PN).catch(() => null)
        if (lid) targetJids.add(lid)
      }
      if (receivedPendingNotifications && !settled) {
        settled = true
        resolve({ sock, saveCreds })
      }
      if (connection === 'close' && !shuttingDown) {
        const code = lastDisconnect?.error?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
          const e = new Error('Session was logged out by WhatsApp. Run `wa login` again.')
          if (!settled) return reject(e)
          err(e.message)
          process.exit(1)
        }
        if (code !== DisconnectReason.restartRequired) {
          onStatus(`Connection closed (${code ?? 'unknown'}: ${lastDisconnect?.error?.message ?? ''}), reconnecting…`)
          await new Promise((r) => setTimeout(r, 2000))
        }
        // restartRequired after QR scan, or a transient drop: reconnect
        if (!settled || persistent) {
          connect({ onMessages, onSocket, onStatus, persistent }).then(
            (res) => {
              if (!settled) {
                settled = true
                resolve(res)
              }
            },
            (e) => (settled ? (err(e.message), process.exit(1)) : reject(e)),
          )
        }
      }
    })

    const store = (msgs) => {
      const added = addMessages(msgs, isTarget)
      if (added.length && onMessages) onMessages(added)
    }
    sock.ev.on('messaging-history.set', ({ messages }) => store(messages))
    sock.ev.on('messages.upsert', ({ messages }) => store(messages))
  })
}

async function disconnect(sock) {
  shuttingDown = true
  // let pending creds / store writes flush before closing
  await new Promise((r) => setTimeout(r, 1500))
  sock.end(undefined)
}

// ---------- tui ----------

async function tui() {
  const history = 20
  out(`\x1b[2J\x1b[H\x1b[1m WhatsApp · ${TARGET_LABEL}\x1b[0m`)
  out('\x1b[2m Type a message and press Enter. /history N to show more, /quit to exit.\x1b[0m\n')
  for (const rec of loadStore().slice(-history)) out(formatRecord(rec, { color: true }))

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.setPrompt('\x1b[1m> \x1b[0m')

  // print above the input line without clobbering what the user is typing
  const print = (line) => {
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    out(line)
    rl.prompt(true)
  }

  let sock
  err('\x1b[2mConnecting…\x1b[0m')
  await connect({
    persistent: true,
    onSocket: (s) => (sock = s),
    onStatus: (s) => print(`\x1b[33m${s}\x1b[0m`),
    onMessages: (added) => added.forEach((rec) => print(formatRecord(rec, { color: true }))),
  })
  print('\x1b[2mConnected.\x1b[0m')

  rl.on('line', async (line) => {
    const text = line.trim()
    // erase the echoed input line; the sent message is printed back via messages.upsert
    readline.moveCursor(process.stdout, 0, -1)
    readline.clearLine(process.stdout, 0)
    if (!text) return rl.prompt()
    if (text === '/quit' || text === '/q') return rl.close()
    const hist = text.match(/^\/history\s+(\d+)$/)
    if (hist) {
      loadStore().slice(-Number(hist[1])).forEach((rec) => print(formatRecord(rec, { color: true })))
      return
    }
    try {
      await sock.sendMessage(TARGET_PN, { text })
    } catch (e) {
      print(`\x1b[31mSend failed: ${e.message}\x1b[0m`)
    }
  })

  rl.on('close', async () => {
    await disconnect(sock)
    process.exit(0)
  })
  rl.prompt()
}

// ---------- commands ----------

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit' || a === '-n') flags.limit = Number(argv[++i])
    else if (a.startsWith('--limit=')) flags.limit = Number(a.slice(8))
    else rest.push(a)
  }
  return { flags, rest }
}

const commands = {
  async login() {
    const { sock } = await connect()
    out(`Logged in as ${sock.user?.id}. Session saved to ${AUTH_DIR}`)
    // give the initial history sync a moment to land in the store
    await new Promise((r) => setTimeout(r, 8000))
    await disconnect(sock)
  },

  async send({ rest }) {
    const text = rest.join(' ').trim()
    if (!text) throw new Error('Usage: wa send "message"')
    const { sock } = await connect()
    const sent = await sock.sendMessage(TARGET_PN, { text })
    addMessages([sent], () => true)
    out('Message sent.')
    await disconnect(sock)
  },

  async read({ flags }) {
    const limit = flags.limit > 0 ? flags.limit : 10
    const { sock } = await connect()
    // pending offline messages arrive right after the connection settles
    await disconnect(sock)
    const messages = loadStore().slice(-limit)
    if (!messages.length) out('No messages.')
    for (const rec of messages) out(formatRecord(rec))
  },

  async listen() {
    await connect({
      persistent: true,
      onMessages: (added) => added.forEach((rec) => out(formatRecord(rec))),
    })
    err('Listening… (Ctrl+C to quit)')
  },

  tui,

  async logout() {
    const { sock } = await connect()
    shuttingDown = true
    await sock.logout()
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    out('Logged out.')
  },
}

const usage = `Usage:
  wa login                 Link your account (QR code)
  wa send "message"        Send a message to ${TARGET_LABEL}
  wa read [--limit N]      Show the last N messages (default 10)
  wa listen                Print new messages in real time
  wa tui                   Interactive chat
  wa logout                Unlink this device`

const [cmd, ...argv] = process.argv.slice(2)
const run = commands[cmd]
if (!run) {
  out(usage)
  process.exit(cmd ? 1 : 0)
}
const keepAlive = cmd === 'listen' || cmd === 'tui'
run(parseArgs(argv)).then(
  () => !keepAlive && process.exit(0),
  (e) => {
    err(e.message)
    process.exit(1)
  },
)
