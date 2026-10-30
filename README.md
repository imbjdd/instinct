# instinct

Unofficial WhatsApp CLI built on [Baileys](https://baileys.wiki/). Link your account by scanning a QR code, then send, read and chat with a single contact from your terminal.

> Not affiliated with WhatsApp or Meta. Using unofficial clients may go against WhatsApp's terms of service; use at your own risk.

## Install

```bash
git clone https://github.com/imbjdd/instinct.git
cd instinct
npm install
npm link   # exposes the `instinct` command
```

Requires Node.js 20+.

## Usage

```bash
instinct login                  # link your account (scan the QR from WhatsApp > Linked devices)
instinct send "Hey, you free?"  # send a message
instinct read                   # last 10 messages
instinct read --limit 20        # last 20 messages
instinct listen                 # print new messages in real time
instinct tui                    # interactive chat
instinct logout                 # unlink this device
```

In `instinct tui`, type a message and press Enter to send. `/history N` shows more history, `/quit` exits.

## How it works

- The session is saved in `~/.instinct/auth`, so you only scan the QR once.
- Baileys doesn't keep messages between runs, so instinct stores the conversation in `~/.instinct/messages.json` (history sync on login, offline messages, and everything received while connected).
- `instinct read` connects for a few seconds to fetch pending messages, then prints from that store.
- Set `INSTINCT_HOME` to use a different data directory.

## License

MIT
