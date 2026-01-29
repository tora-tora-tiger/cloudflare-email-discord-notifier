import * as PostalMime from "postal-mime"
import TurndownService from "turndown"
import { parseHTML } from "linkedom/worker"

export const parseEnv = (env: string | undefined): string[] => {
  if (!env) {
    return []
  }
  const regex = /"([^"]*)"|'([^']*)'|([^\s,]+)/g
  const matches = [...env.matchAll(regex)]
  return matches.map((match) => match.slice(1).find((capture) => capture !== undefined) || "")
}

export default {
  async email(message: ForwardableEmailMessage, env, ctx): Promise<void> {
    const recipients = parseEnv(env.RECIPIENTS)
    console.log({ "Recipients:": recipients })

    const discordWebhooks = parseEnv(env.DISCORD_WEBHOOKS)
    console.log({ "Discord Webhooks": discordWebhooks })

    await Promise.allSettled([
      sendDiscordNotification(message, discordWebhooks),
      forwardEmails(message, recipients)
    ]).catch((err) => {
      console.error({ "Error in processing email:": err })
    })
  }
} satisfies ExportedHandler<Env>

const forwardEmails = async (message: ForwardableEmailMessage, addresses: string[]) => {
  await Promise.allSettled(
    addresses.map(async (address) => {
      try {
        await message.forward(address)
        console.log(`Email forwarded to: ${address}`)
      } catch (error) {
        console.error(`Failed to forward email to ${address}:`, error)
      }
    })
  )
}

const DISCORD_MESSAGE_LIMIT = 2000
const DISCORD_SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12

/**
 * メール内容をパースし、DiscordのWebhookに通知を送信する関数
 */
const sendDiscordNotification = async (
  message: ForwardableEmailMessage,
  webhookUrls: string[]
): Promise<void> => {
  const parser = new PostalMime.default()
  const rawEmail = new Response(message.raw)
  const email = await parser.parse(await rawEmail.arrayBuffer())

  const from = formatSingleAddress(email.from)
  const to = formatAddresses(email.to)
  const cc = formatAddresses(email.cc)
  const bcc = formatAddresses(email.bcc)
  const subject = message.headers.get("subject")

  const markdownBody = convertEmailToMarkdown(email)
  const headerLines = [
    `件名: ${subject || "No Subject"}`,
    `From: ${from}`,
    `To: ${to}`,
    `CC: ${cc}`,
    `BCC: ${bcc}`
  ]

  const fullMessage = `${headerLines.join("\n")}\n\n${markdownBody}`.trim()
  const chunks = chunkForDiscord(fullMessage, DISCORD_MESSAGE_LIMIT)

  await sendDiscordChunks(chunks, webhookUrls)
}

const formatAddresses = (addresses: PostalMime.Address[] | undefined): string => {
  if (!addresses || addresses.length === 0) {
    return "N/A"
  }
  return addresses.map((addr) => `${addr.name} <${addr.address}>`).join(", ")
}

const formatSingleAddress = (address: PostalMime.Address | undefined): string => {
  if (!address) {
    return "N/A"
  }
  const displayName = address.name ? `${address.name} ` : ""
  return `${displayName}<${address.address}>`
}

type UrlRange = { start: number; end: number }

const stripUrlNewlines = (url: string): string => url.replace(/\r?\n+/g, "")

const isUrlLike = (s: string): boolean => /^(https?:\/\/|https?:%2F%2F|www\.)/i.test(s)

const findUrlRanges = (text: string): UrlRange[] => {
  const ranges: UrlRange[] = []
  const urlRegex = /(?:https?:\/\/|https?:%2F%2F)[^\s<>"']+/gi
  let m: RegExpExecArray | null
  while ((m = urlRegex.exec(text)) !== null) {
    const urlStart = m.index
    let urlEnd = m.index + m[0].length

    while (urlEnd > urlStart && /[),.\]]/.test(text[urlEnd - 1])) {
      urlEnd -= 1
    }

    if (urlEnd > urlStart) {
      let start = urlStart
      let end = urlEnd

      if (start >= 2 && text.slice(start - 2, start) === "](") {
        start -= 2
      } else if (start >= 1 && text[start - 1] === "(") {
        start -= 1
      }

      if (end < text.length && text[end] === ")") {
        end += 1
      }

      ranges.push({ start, end })
    }
  }
  return ranges
}

const isIndexInsideRanges = (i: number, ranges: UrlRange[]): UrlRange | null => {
  for (const r of ranges) {
    if (r.start < i && i < r.end) {
      return r
    }
  }
  return null
}

const normalizeBrokenUrlText = (text: string): string => {
  let out = text

  out = out.replace(
    /(?:https?:\/\/|https?:%2F%2F)[^\s<>"']+(?:\r?\n+[^\s<>"']+)+/gi,
    (m) => stripUrlNewlines(m)
  )

  out = out.replace(/!\s*(?=(https?:\/\/|https?:%2F%2F))/g, "")

  out = out.replace(
    /(^|[\s\r\n、。,:;])\]\(\s*([^\s)]+(?:\r?\n+[^\s)]+)*)\s*\)/gim,
    (_m, p1, maybeUrl) => {
      const u = stripUrlNewlines(String(maybeUrl))
      if (!isUrlLike(u)) {
        return String(p1) + "](" + maybeUrl + ")"
      }
      return `${String(p1)} ${u} `
    }
  )

  out = out.replace(
    /(^|[\s\r\n])\]\(\s*((?:https?:\/\/|https?:%2F%2F)[^\s)]+)\s*\)/gim,
    (_m, p1, url) => `${String(p1)} ${stripUrlNewlines(String(url))} `
  )

  out = out.replace(
    /\]\(\s*((?:https?:\/\/|https?:%2F%2F)[^\s)]+)\s*$/gim,
    (_m, url) => ` ${stripUrlNewlines(String(url))} `
  )

  out = out.replace(/\]\(\s*$/gm, "")

  return out
}

/**
 * Discord webhook 送信
 */
export const sendDiscordChunks = async (
  chunks: string[],
  webhookUrls: string[],
  fetchFn: typeof fetch = fetch
): Promise<void> => {
  for (const webhookUrl of webhookUrls) {
    let sentChunkCount = 0
    for (const chunk of chunks) {
      if (!chunk) {
        continue
      }
      const payload: { content: string; flags?: number } = { content: chunk }
      if (sentChunkCount > 0) {
        payload.flags = DISCORD_SUPPRESS_NOTIFICATIONS_FLAG
      }
      const response = await fetchFn(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        console.error(
          `Failed to send Discord notification to ${webhookUrl}: ${response.status} ${response.statusText}`
        )
        const errorText = await response.text()
        console.error({ "Discord API response": errorText })
      }
      sentChunkCount += 1
    }
  }
}

/**
 * Markdownの書式問題を修正する
 */
export const fixMarkdownFormatting = (markdown: string): string => {
  let fixed = normalizeBrokenUrlText(markdown)

  fixed = fixed.replace(/\\\[/g, "[")
  fixed = fixed.replace(/\\\]/g, "]")
  fixed = fixed.replace(/\[\[/g, "[")
  fixed = fixed.replace(/\]\]/g, "]")

  fixed = fixed.replace(/(\])\](\()/g, "]$2")
  fixed = fixed.replace(/(\])\)\](\()/g, "]$2")

  fixed = fixed.replace(/\[!\[([^\]]*)\]\([^\)]+\)\]\(([^\)]+)\)/g, "[$1]($2)")

  fixed = fixed.replace(/\[\s*\]\(([^)]+)\)/g, (_m, url) => ` ${stripUrlNewlines(String(url))} `)

  fixed = fixed.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, url) => `\n${stripUrlNewlines(String(url))}\n`)

  fixed = fixed.replace(/(\]\([^)]+\))([![])/g, "$1 $2")
  fixed = fixed.replace(/(\]\([^)]+\))([^\x00-\x7F])/g, "$1 $2")

  fixed = fixed.replace(/^\|[\s]*/gm, "")
  fixed = fixed.replace(/[\s]*\|$/gm, "")

  fixed = fixed.replace(/^[\s]*[-—]{3,}[\s]*$/gm, "")
  fixed = fixed.replace(/^[\s]*-\s*[-—]{3,}[\s]*$/gm, "")
  fixed = fixed.replace(/^[\s:]*[-—]{3,}([\s:]+[-—:]{3,})+[\s:]*$/gm, "")

  fixed = normalizeBrokenUrlText(fixed)

  fixed = fixed.replace(/^\s*!\s*$/gm, "")
  fixed = fixed.replace(/!\[\s*$/gm, "")

  fixed = fixed.replace(/(^|[\s\r\n])\[(?=[\s\r\n]|$)/g, "$1")
  fixed = fixed.replace(/(^|[\s\r\n])\](?=[\s\r\n]|$)/g, "$1")
  fixed = fixed.replace(/(^|[\s\r\n])\)(?=[\s\r\n]|$)/g, "$1")

  fixed = fixed.replace(/\]\(\s*$/gm, "")

  fixed = fixed.replace(/^[\s\u034F\u00AD]*$/gm, "")

  fixed = fixed.replace(/<[^>]+>/g, "")

  return fixed.trim()
}

/**
 * HTML -> Markdown（turndown + linkedom/worker）
 * Workers には DOM が無いので linkedom で document を作る
 */
export const htmlToMarkdown = (html: string): string => {
  const turndown = new TurndownService({
    codeBlockStyle: "fenced"
  })
  const { document } = parseHTML(html)
  return turndown.turndown(document.body)
}

/**
 * フォールバック無し:
 * - HTML があれば turndown で Markdown 化し、整形して返す
 * - HTML が無ければ text を返す（整形は不要なのでそのまま）
 */
const convertEmailToMarkdown = (email: PostalMime.Email): string => {
  const html = email.html
  if (html) {
    const markdown = htmlToMarkdown(html)
    return fixMarkdownFormatting(markdown)
  }
  if (email.text) {
    return email.text
  }
  return "(本文なし)"
}

export const chunkForDiscord = (content: string, limit: number): string[] => chunkText(content, limit)

const chunkText = (content: string, limit: number): string[] => {
  const chunks: string[] = []
  let remaining = content

  while (remaining.length > limit) {
    const urlRanges = findUrlRanges(remaining)

    let splitIndex = remaining.lastIndexOf("\n", limit)
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(" ", limit)
    }
    if (splitIndex <= 0) {
      splitIndex = limit
    }

    const inside = isIndexInsideRanges(splitIndex, urlRanges)
    if (inside) {
      let protectedStart = inside.start

      const lookbehindStart = Math.max(0, protectedStart - 300)
      const before = remaining.slice(lookbehindStart, protectedStart)
      const lastNewline = before.lastIndexOf("\n")
      const lastBracket = before.lastIndexOf("[")
      if (lastBracket !== -1 && lastBracket > lastNewline) {
        protectedStart = lookbehindStart + lastBracket
      }

      if (protectedStart > 0) {
        splitIndex = protectedStart
      }
    }

    if (splitIndex <= 0) {
      splitIndex = limit
    }

    let chunkRaw = remaining.slice(0, splitIndex)
    chunkRaw = chunkRaw.replace(/\]\(\s*$/g, "")
    const chunk = chunkRaw.trimEnd()
    if (chunk) {
      chunks.push(chunk)
    }
    remaining = remaining.slice(splitIndex).trimStart()
  }

  if (remaining.length > 0) {
    const cleaned = remaining.replace(/\]\(\s*$/g, "")
    if (cleaned.length > 0) {
      chunks.push(cleaned)
    }
  }

  return chunks
}
