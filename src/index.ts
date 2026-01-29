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

const sendDiscordNotification = async (
  message: ForwardableEmailMessage,
  webhookUrls: string[]
): Promise<void> => {
  const parser = new PostalMime.default()
  const rawEmail = new Response(message.raw)
  const email = await parser.parse(await rawEmail.arrayBuffer())

  console.log("parsed keys", JSON.stringify(Object.keys(email)))
  console.log("has html", String(Boolean(email.html)), "html len", String(email.html?.length ?? 0))
  console.log("has text", String(Boolean(email.text)), "text len", String(email.text?.length ?? 0))
  console.log("subject", message.headers.get("subject") || "")

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
  // メールの区切りとして区切り線と空白を追加
  const messageWithSeparator = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${fullMessage}`
  const chunks = chunkForDiscord(messageWithSeparator, DISCORD_MESSAGE_LIMIT)

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
 * Markdown整形（画像は消さない・リンクも保持）
 */
export const fixMarkdownFormatting = (markdown: string): string => {
  let fixed = normalizeBrokenUrlText(markdown)

  fixed = fixed.replace(/\\\[/g, "[")
  fixed = fixed.replace(/\\\]/g, "]")
  fixed = fixed.replace(/\[\[/g, "[")
  fixed = fixed.replace(/\]\]/g, "]")

  fixed = fixed.replace(/(\])\](\()/g, "]$2")
  fixed = fixed.replace(/(\])\)\](\()/g, "]$2")

  // 空のリンクテキストのみ url 化（[](url) → url）
  fixed = fixed.replace(/\[\s*\]\(([^)]+)\)/g, (_m, url) => ` ${stripUrlNewlines(String(url))} `)

  fixed = fixed.replace(/(\]\([^)]+\))([![])/g, "$1 $2")
  fixed = fixed.replace(/(\]\([^)]+\))([^\x00-\x7F])/g, "$1 $2")

  // 区切り線を削除
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

  return fixed.trim()
}

type ImgLinkRewriteOptions = {
  addBlankLineBetween: boolean
}

const squashDoubleBrackets = (s: string): string => {
  let out = s
  // Discordで崩れて "[[" / "]]" になるケースを単純化
  while (out.includes("[[")) {
    out = out.replace(/\[\[/g, "[")
  }
  while (out.includes("]]")) {
    out = out.replace(/\]\]/g, "]")
  }
  return out
}

const ensureLinkSeparation = (s: string): string => {
  let out = s

  // Markdownリンクの直後に次のリンク/画像がくっつくのを分離
  // 例: "](a)[x](b)" / "](a)![x](b)" / "](a)(b)" のような崩れを避ける
  out = out.replace(/(\]\([^)]+\))(?=\[)/g, "$1\n")
  out = out.replace(/(\]\([^)]+\))(?=!)/g, "$1\n")

  // 画像URLや通常URLが連結してしまうケースを最低限分離
  out = out.replace(/(https?:\/\/[^\s<>"']+)(?=https?:\/\/)/g, "$1\n")

  return out
}

/**
 * Discord向け:
 * [![alt](img)](link) を
 * [alt](link)\n\nimg
 * に変換する
 */
export const rewriteImageLinksForDiscord = (
  markdown: string,
  options: ImgLinkRewriteOptions = { addBlankLineBetween: true }
): string => {
  const blank = options.addBlankLineBetween ? "\n\n" : "\n"
  let out = markdown

  // まずURL内改行を除去（img/link共に）
  out = out.replace(
    /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g,
    (_m, altRaw, imgRaw, linkRaw) => {
      const alt = String(altRaw || "").trim()
      const img = stripUrlNewlines(String(imgRaw || "").trim())
      const link = stripUrlNewlines(String(linkRaw || "").trim())

      // altが空なら、リンクテキストはURLを使う
      const label = alt.length > 0 ? alt : link

      // 画像URLだけを別行に出す（画像は画像として保持しない方針）
      // ※Discordで画像展開させたいなら、この行はURL単体が一番強い
      return `[${label}](${link})${blank}${img}`
    }
  )

  // まれに "! [alt](img)" のような崩れ方を拾う（空白入り）
  out = out.replace(
    /\[\s*!\[([^\]]*)\]\(\s*([^)]+)\s*\)\s*\]\(\s*([^)]+)\s*\)/g,
    (_m, altRaw, imgRaw, linkRaw) => {
      const alt = String(altRaw || "").trim()
      const img = stripUrlNewlines(String(imgRaw || "").trim())
      const link = stripUrlNewlines(String(linkRaw || "").trim())
      const label = alt.length > 0 ? alt : link
      return `[${label}](${link})${blank}${img}`
    }
  )

  out = squashDoubleBrackets(out)
  out = ensureLinkSeparation(out)

  return out
}

const removeUnmatchedOpenBrackets = (s: string): string => {
  const urlRanges = findUrlRanges(s)
  const opens: number[] = []
  const remove = new Set<number>()

  let i = 0
  let inFence = false
  let inInline = false

  const isEscaped = (idx: number): boolean => idx > 0 && s[idx - 1] === "\\"

  while (i < s.length) {
    // code fence ``` ... ```
    if (!inInline && s.startsWith("```", i)) {
      inFence = !inFence
      i += 3
      continue
    }

    const ch = s[i]

    // inline code `...`
    if (!inFence && ch === "`") {
      inInline = !inInline
      i += 1
      continue
    }

    if (!inFence && !inInline) {
      const inUrl = isIndexInsideRanges(i, urlRanges) !== null
      if (!inUrl && !isEscaped(i)) {
        if (ch === "[") {
          opens.push(i)
        } else if (ch === "]") {
          if (opens.length > 0) {
            opens.pop()
          }
        }
      }
    }

    i += 1
  }

  for (const idx of opens) {
    remove.add(idx)
  }

  if (remove.size === 0) {
    return s
  }

  let out = ""
  for (let j = 0; j < s.length; j += 1) {
    if (!remove.has(j)) {
      out += s[j]
    }
  }
  return out
}


/**
 * Discordに投げる直前の最終整形:
 * - "[[" / "]]" の抑制
 * - リンク同士がくっつくのを抑制
 * - 画像付きリンクの入れ替え（rewriteImageLinksForDiscord）
 */
export const finalizeDiscordMarkdown = (markdown: string): string => {
  let out = markdown

  out = rewriteImageLinksForDiscord(out, { addBlankLineBetween: true })

  // 追加の括弧残骸を軽く掃除（過剰にはやらない）
  out = out.replace(/\]\(\s*$/gm, "")
  out = out.replace(/^\s*!\s*$/gm, "")

  // 空行が増えすぎたら2行までに抑える
  out = out.replace(/\n{3,}/g, "\n\n")

	// ここを追加：対になっていない "[" だけを除去
  out = removeUnmatchedOpenBrackets(out)

  return out.trim()
}

const escapeHtml = (s: string): string => {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const textToHtml = (text: string): string => {
  const escaped = escapeHtml(text)
  const withBr = escaped.replace(/\r?\n/g, "<br>")
  return `<div>${withBr}</div>`
}

const getAttr = (el: any, name: string): string => {
  const v = el?.getAttribute?.(name)
  return typeof v === "string" ? v : ""
}

const pickImgUrl = (img: any): string => {
  const src = getAttr(img, "src")
  if (src) {
    return src
  }
  const dataSrc = getAttr(img, "data-src") || getAttr(img, "data-original") || getAttr(img, "data-lazy-src")
  if (dataSrc) {
    return dataSrc
  }
  const srcset = getAttr(img, "srcset")
  if (srcset) {
    const first = srcset.split(",")[0]?.trim() || ""
    const url = first.split(/\s+/)[0] || ""
    return url
  }
  return ""
}

/**
 * linkedom の配置差（bodyが空でdocument側に中身がある）を吸収して、
 * turndown に渡す root を正しく選ぶ
 */
const pickRootNodeForTurndown = (document: any): any => {
  const candidates: any[] = []
  if (document?.body) {
    candidates.push(document.body)
  }
  if (document?.documentElement) {
    candidates.push(document.documentElement)
  }
  candidates.push(document)

  const score = (node: any): number => {
    if (!node) {
      return 0
    }
    const textLen = String(node.textContent || "").trim().length
    const imgCount = node.querySelectorAll ? node.querySelectorAll("img").length : 0
    const aCount = node.querySelectorAll ? node.querySelectorAll("a").length : 0
    const childCount = node.childNodes ? node.childNodes.length : 0
    return textLen * 2 + imgCount * 50 + aCount * 10 + childCount
  }

  let best = candidates[0]
  let bestScore = score(best)

  for (const c of candidates.slice(1)) {
    const s = score(c)
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }

  return best
}

/**
 * turndown を Workers で確実に動かす（画像・リンク保持）
 */
export const htmlToMarkdown = (html: string): string => {
  const { document } = parseHTML(html)
  const root = pickRootNodeForTurndown(document)

  const td = new TurndownService({
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    headingStyle: "atx",
    bulletListMarker: "-"
  })

  // 余計な要素は落とす（turndownで削除）
  td.addRule("removeNoise", {
    filter: ["script", "style", "meta", "link", "noscript", "title", "head"],
    replacement: () => ""
  })

  // 画像を必ず保持（data-src/srcsetも拾う）
  td.addRule("imgKeep", {
    filter: (node) => {
      return node.nodeName === "IMG"
    },
    replacement: (_content, node: any) => {
      const url = pickImgUrl(node)
      if (!url) {
        return ""
      }
      const alt = getAttr(node, "alt") || ""
      return `![${alt}](${stripUrlNewlines(url)})`
    }
  })

  // リンクを必ず保持（空ラベルならURLをラベルにする）
  td.addRule("aKeep", {
    filter: (node) => {
      return node.nodeName === "A"
    },
    replacement: (content: string, node: any) => {
      const href = getAttr(node, "href")
      const u = stripUrlNewlines(href)
      const label = content && content.trim().length > 0 ? content.trim() : u
      if (!u) {
        return label
      }
      return `[${label}](${u})`
    }
  })

  const md = td.turndown(root)

  // デバッグログ（必要なら残す）
  console.log("turndown root", root?.nodeName || "(unknown)")
  console.log("turndown root text len", String((root?.textContent || "").trim().length))
  console.log("turndown md len", String(md.length))

  return md
}

/**
 * turndown 必須:
 * - HTMLがあればそれを turndown
 * - HTMLが無ければ text を HTML 化して turndown
 */
const convertEmailToMarkdown = (email: PostalMime.Email): string => {
  const html = email.html
  const text = email.text

  if (html && html.trim().length > 0) {
    const md = htmlToMarkdown(html)
    const formatted = fixMarkdownFormatting(md)
    return finalizeDiscordMarkdown(formatted)
  }

  if (text && text.trim().length > 0) {
    const pseudoHtml = textToHtml(text)
    const md = htmlToMarkdown(pseudoHtml)
    const formatted = fixMarkdownFormatting(md)
    return finalizeDiscordMarkdown(formatted)
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
