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

	for (const webhookUrl of webhookUrls) {
		for (const chunk of chunks) {
			if (!chunk) {
				continue;
			}
			const response = await fetch(webhookUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ content: chunk }),
			});

			if (!response.ok) {
				console.error(
					`Failed to send Discord notification to ${webhookUrl}: ${response.status} ${response.statusText}`
				);
				const errorText = await response.text();
				console.error({ 'Discord API response': errorText });
			}
		}
	}
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
				return markdown;
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

const chunkForDiscord = (content: string, limit: number): string[] => {
	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > limit) {
		let splitIndex = remaining.lastIndexOf('\n', limit);
		if (splitIndex <= 0) {
			splitIndex = limit;
		}
		const chunk = remaining.slice(0, splitIndex).trimEnd();
		chunks.push(chunk);
		remaining = remaining.slice(splitIndex).trimStart();
	}

	if (remaining.length > 0) {
		chunks.push(remaining);
	}

	return chunks;
};
