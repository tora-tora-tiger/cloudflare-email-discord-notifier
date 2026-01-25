/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import * as PostalMime from 'postal-mime';

export const parseEnv = (env: string | undefined): string[] => {
	if (!env) {
		return [];
	}
	// カンマまたは空白でパース，引用符で囲まれた部分はそのまま取得
	const regex = /"([^"]*)"|'([^']*)'|([^\s,]+)/g;
	const matches = [...env.matchAll(regex)];
	return matches.map((match) => match.slice(1).find((capture) => capture !== undefined) || '');
};

export default {
	async email(message: ForwardableEmailMessage, env, ctx): Promise<void> {
		// 転送したいメールアドレスをすべて記載します
		// これらのアドレスは事前にCloudflareで認証済みである必要があります
		const recipients = parseEnv(env.RECIPIENTS);
		console.log({ 'Recipients:': recipients });

		const discordWebhooks = parseEnv(env.DISCORD_WEBHOOKS);
		console.log({ 'Discord Webhooks': discordWebhooks });

		await Promise.allSettled([
			sendDiscordNotification(message, discordWebhooks, env),
			forwardEmails(message, recipients),
		]).catch((err) => {
			console.error({ 'Error in processing email:': err });
		});
	},
} satisfies ExportedHandler<Env>;

const forwardEmails = async (message: ForwardableEmailMessage, addresses: string[]) => {
	await Promise.allSettled(
		addresses.map(async (address) => {
			try {
				await message.forward(address);
				console.log(`Email forwarded to: ${address}`);
			} catch (error) {
				console.error(`Failed to forward email to ${address}:`, error);
			}
		})
	);
};


const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

type ToMarkdownResult = {
	name: string;
	mimetype: string;
	tokens: number;
	data: string;
};

/**
 * メール内容をパースし、DiscordのWebhookに通知を送信する関数
 * @param message - ForwardableEmailMessage オブジェクト
 * @param webhookUrl - DiscordのWebhook URL
 */
const sendDiscordNotification = async (
	message: ForwardableEmailMessage,
	webhookUrls: string[],
	env: Env
): Promise<void> => {
	const parser = new PostalMime.default();
	const rawEmail = new Response(message.raw);
	const email = await parser.parse(await rawEmail.arrayBuffer());

	// 1. メールのメタデータを取得
	const from = formatSingleAddress(email.from);
	const to = formatAddresses(email.to);
	const cc = formatAddresses(email.cc);
	const bcc = formatAddresses(email.bcc);
	const subject = message.headers.get('subject');
	const markdownBody = await convertEmailToMarkdown(email, env.AI);
	const headerLines = [
		`件名: ${subject || 'No Subject'}`,
		`From: ${from}`,
		`To: ${to}`,
		`CC: ${cc}`,
		`BCC: ${bcc}`,
	];

	const fullMessage = `${headerLines.join('\n')}\n\n${markdownBody}`.trim();
	const chunks = chunkForDiscord(fullMessage, DISCORD_MESSAGE_LIMIT);

	await sendDiscordChunks(chunks, webhookUrls);
};

const formatAddresses = (addresses: PostalMime.Address[] | undefined): string => {
	if (!addresses || addresses.length === 0) {
		return 'N/A';
	}
	return addresses.map((addr) => `${addr.name} <${addr.address}>`).join(', ');
};

const formatSingleAddress = (address: PostalMime.Address | undefined): string => {
	if (!address) {
		return 'N/A';
	}
	const displayName = address.name ? `${address.name} ` : '';
	return `${displayName}<${address.address}>`;
};

type UrlRange = { start: number; end: number };

const stripUrlNewlines = (url: string): string => url.replace(/\r?\n+/g, '');

const isUrlLike = (s: string): boolean => /^(https?:\/\/|https?:%2F%2F|www\.)/i.test(s);

const findUrlRanges = (text: string): UrlRange[] => {
	const ranges: UrlRange[] = [];
	// "https://..." と "https:%2F%2F..." の両方をURL扱いして、途中分割を防ぐ
	const urlRegex = /(?:https?:\/\/|https?:%2F%2F)[^\s<>"']+/gi;
	let m: RegExpExecArray | null;
	while ((m = urlRegex.exec(text)) !== null) {
		const urlStart = m.index;
		let urlEnd = m.index + m[0].length;

		// 末尾の一般的な句読点を落とす
		while (urlEnd > urlStart && /[),.\]]/.test(text[urlEnd - 1])) {
			urlEnd -= 1;
		}

		if (urlEnd > urlStart) {
			// 直前の "](...)" / "(...)" を保護して、区切り位置が "](" などに当たらないようにする
			let start = urlStart;
			let end = urlEnd;

			if (start >= 2 && text.slice(start - 2, start) === '](') {
				start -= 2;
			} else if (start >= 1 && text[start - 1] === '(') {
				start -= 1;
			}

			// URL直後の ")" も保護（markdownリンクの閉じ括弧）
			if (end < text.length && text[end] === ')') {
				end += 1;
			}

			ranges.push({ start, end });
		}
	}
	return ranges;
};

const isIndexInsideRanges = (i: number, ranges: UrlRange[]): UrlRange | null => {
	for (const r of ranges) {
		if (r.start < i && i < r.end) {
			return r;
		}
	}
	return null;
};

const normalizeBrokenUrlText = (text: string): string => {
	let out = text;

	// 1) 改行で分断されたURLを連結
	out = out.replace(
		/(?:https?:\/\/|https?:%2F%2F)[^\s<>"']+(?:\r?\n+[^\s<>"']+)+/gi,
		(m) => stripUrlNewlines(m)
	);

	// 2) URL直前の「!」残骸を削除（例: "!https://..." / "! https://..."）
	out = out.replace(/!\s*(?=(https?:\/\/|https?:%2F%2F))/g, '');

	// 3) 破損した "]( ... )" を URL テキストへ（直前に "[" が無いケースも含めて拾う）
	//    例: "\n](https://...)" / " ](\nhttps://... )" / " ](https:%2F%2F...)"
	out = out.replace(
		/(^|[\s\r\n、。,:;])\]\(\s*([^\s)]+(?:\r?\n+[^\s)]+)*)\s*\)/gim,
		(_m, p1, maybeUrl) => {
			const u = stripUrlNewlines(String(maybeUrl));
			if (!isUrlLike(u)) {
				return String(p1) + '](' + maybeUrl + ')';
			}
			return `${String(p1)} ${u} `;
		}
	);

	// 3.5) まだ残っている " ](https://...)" を確実にURL化（markdownリンク "[text](url)" は壊さない）
	out = out.replace(
		/(^|[\s\r\n])\]\(\s*((?:https?:\/\/|https?:%2F%2F)[^\s)]+)\s*\)/gim,
		(_m, p1, url) => `${String(p1)} ${stripUrlNewlines(String(url))} `
	);

	// 4) "](url" のように閉じ括弧が欠けた残骸もURLとして救出（行末に残ったケースのみ）
	out = out.replace(
		/\]\(\s*((?:https?:\/\/|https?:%2F%2F)[^\s)]+)\s*$/gim,
		(_m, url) => ` ${stripUrlNewlines(String(url))} `
	);

	// 5) 行末に残った "](" を削除（URLが次チャンク等に逃げて残骸だけ残るケース）
	out = out.replace(/\]\(\s*$/gm, '');

	return out;
};

export const sendDiscordChunks = async (
	chunks: string[],
	webhookUrls: string[],
	fetchFn: typeof fetch = fetch
): Promise<void> => {
	for (const webhookUrl of webhookUrls) {
		let sentChunkCount = 0;
		for (const chunk of chunks) {
			if (!chunk) {
				continue;
			}
			const payload: { content: string; flags?: number } = { content: chunk };
			if (sentChunkCount > 0) {
				payload.flags = DISCORD_SUPPRESS_NOTIFICATIONS_FLAG;
			}
			const response = await fetchFn(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				console.error(
					`Failed to send Discord notification to ${webhookUrl}: ${response.status} ${response.statusText}`
				);
				const errorText = await response.text();
				console.error({ 'Discord API response': errorText });
			}
			sentChunkCount += 1;
		}
	}
};

/**
 * Markdownの書式問題を修正する
 */
export const fixMarkdownFormatting = (markdown: string): string => {
	// 0. URL周りの破損を先に正規化
	let fixed = normalizeBrokenUrlText(markdown);

	// 1. エスケープされた括弧を修正（最初に処理）
	fixed = fixed.replace(/\\\[/g, '[');
	fixed = fixed.replace(/\\\]/g, ']');
	// 連続する括弧を修正（エスケープ解除後に発生する[[や]]を修正）
	fixed = fixed.replace(/\[\[/g, '[');
	fixed = fixed.replace(/\]\]/g, ']');

	// 2. 連続する閉じ括弧を修正
	fixed = fixed.replace(/(\])\](\()/g, ']$2');
	fixed = fixed.replace(/(\])\)\](\()/g, ']$2');

	// 3. 画像リンクをテキストリンクに変換（[![alt](img)](link) → [alt](link)）
	fixed = fixed.replace(/\[!\[([^\]]*)\]\([^\)]+\)\]\(([^\)]+)\)/g, '[$1]($2)');

	// 4. 空のリンクテキストをURLだけにする（[](url) → url）
	fixed = fixed.replace(/\[\s*\]\(([^)]+)\)/g, (_m, url) => ` ${stripUrlNewlines(String(url))} `);

	// 5. 画像を削除してURLのみを残す（![alt](url) → url）
	fixed = fixed.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_m, url) => `\n${stripUrlNewlines(String(url))}\n`);

	// 6. 連続するリンク・画像の間にスペースを挿入
	// ](url)の直後に[や!が来ている場合にスペースを挿入
	fixed = fixed.replace(/(\]\([^)]+\))([![])/g, '$1 $2');

	// 7. リンク・画像の後にテキストがくっついているのを修正
	// ](url)の直後に非ASCII文字が来ている場合にスペースを挿入
	fixed = fixed.replace(/(\]\([^)]+\))([^\x00-\x7F])/g, '$1 $2');

	// 8. テーブル形式のパイプを削除（すべてのテーブル形式を解除）
	// 行頭のパイプを削除
	fixed = fixed.replace(/^\|[\s]*/gm, '');
	// 行末のパイプとスペースを削除
	fixed = fixed.replace(/[\s]*\|$/gm, '');

	// 9. 区切り線を削除（ハイフン連続など）
	// 例: "-----" / "- -----" / ":---:" / "---|---" 等を削除
	fixed = fixed.replace(/^[\s]*[-—]{3,}[\s]*$/gm, '');
	fixed = fixed.replace(/^[\s]*-\s*[-—]{3,}[\s]*$/gm, '');
	fixed = fixed.replace(/^[\s:]*[-—]{3,}([\s:]+[-—:]{3,})+[\s:]*$/gm, '');

	// 9.5 URL/括弧の破損をもう一度回収（後段の置換で残るケース対策）
	fixed = normalizeBrokenUrlText(fixed);

	// 10. URL以外の「!」だけの残骸を削除
	fixed = fixed.replace(/^\s*!\s*$/gm, '');
	fixed = fixed.replace(/!\[\s*$/gm, '');

	// 11. 角括弧/丸括弧だけの残骸を削除
	fixed = fixed.replace(/(^|[\s\r\n])\[(?=[\s\r\n]|$)/g, '$1');
	fixed = fixed.replace(/(^|[\s\r\n])\](?=[\s\r\n]|$)/g, '$1');
	fixed = fixed.replace(/(^|[\s\r\n])\)(?=[\s\r\n]|$)/g, '$1');

	// 12. 行末の "](" を最終掃除（破損リンク残骸）
	fixed = fixed.replace(/\]\(\s*$/gm, '');

	// 13. 空行を削除（空白文字や特殊文字のみの行）
	// ͏ (U+034F) と ­ (U+00AD) とスペースのみで構成される行を削除
	fixed = fixed.replace(/^[\s\u034F\u00AD]*$/gm, '');

	// 14. HTMLタグを削除（DOCTYPE宣言など）
	fixed = fixed.replace(/<[^>]+>/g, '');

	return fixed.trim();
};

const convertEmailToMarkdown = async (email: PostalMime.Email, ai: Env['AI']): Promise<string> => {
	const html = email.html;
	if (html && ai?.toMarkdown) {
		try {
			const results = (await ai.toMarkdown([
				{
					name: 'email.html',
					blob: new Blob([html], { type: 'text/html' }),
				},
			])) as ToMarkdownResult[];
			const markdown = results[0]?.data?.trim();
			if (markdown) {
				return fixMarkdownFormatting(markdown);
			}
		} catch (error) {
			console.error('AI toMarkdown conversion failed:', error);
			return email.html || email.text || '(本文なし)';
		}
	}
	if (email.text) {
		return email.text;
	}
	return '(本文なし)';
};

export const chunkForDiscord = (content: string, limit: number): string[] => chunkText(content, limit);

const chunkText = (content: string, limit: number): string[] => {
	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > limit) {
		const urlRanges = findUrlRanges(remaining);

		let splitIndex = remaining.lastIndexOf('\n', limit);
		if (splitIndex <= 0) {
			splitIndex = remaining.lastIndexOf(' ', limit);
		}
		if (splitIndex <= 0) {
			splitIndex = limit;
		}

		// split位置がURLの途中なら、URL手前に戻す
		const inside = isIndexInsideRanges(splitIndex, urlRanges);
		if (inside) {
			let protectedStart = inside.start;

			// 可能なら markdownリンクの "[" まで戻して、括弧残骸を作らない
			const lookbehindStart = Math.max(0, protectedStart - 300);
			const before = remaining.slice(lookbehindStart, protectedStart);
			const lastNewline = before.lastIndexOf('\n');
			const lastBracket = before.lastIndexOf('[');
			if (lastBracket !== -1 && lastBracket > lastNewline) {
				protectedStart = lookbehindStart + lastBracket;
			}

			if (protectedStart > 0) {
				splitIndex = protectedStart;
			}
		}

		if (splitIndex <= 0) {
			splitIndex = limit;
		}

		let chunkRaw = remaining.slice(0, splitIndex);
		chunkRaw = chunkRaw.replace(/\]\(\s*$/g, '');
		const chunk = chunkRaw.trimEnd();
		if (chunk) {
			chunks.push(chunk);
		}
		remaining = remaining.slice(splitIndex).trimStart();
	}

	if (remaining.length > 0) {
		const cleaned = remaining.replace(/\]\(\s*$/g, '');
		if (cleaned.length > 0) {
			chunks.push(cleaned);
		}
	}

	return chunks;
};
