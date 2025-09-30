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

		const discordWehooks = parseEnv(env.DISCORD_WEBHOOKS);
		
		await Promise.allSettled([
			sendDiscordNotification(message, discordWehooks),
			forwardEmails(message, recipients),
		]);
	},
} satisfies ExportedHandler<Env>;

const forwardEmails = async (message: ForwardableEmailMessage, addresses: string[]) => {
	for (const address of addresses) {
		message.forward(address);
	}
};

// DiscordのWebhookに送信するデータ型を定義
interface DiscordEmbed {
	title: string;
	fields: { name: string; value: string; inline?: boolean }[];
	description?: string;
	color: number;
}

/**
 * メール内容をパースし、DiscordのWebhookに通知を送信する関数
 * @param message - ForwardableEmailMessage オブジェクト
 * @param webhookUrl - DiscordのWebhook URL
 */
const sendDiscordNotification = async (message: ForwardableEmailMessage, webhookUrls: string[]) => {
	const webhookUrl =
		'https://discord.com/api/webhooks/1422571662376702052/YFYGB5QXVZFZbGr4ZKFZmdCqeDh3uOHkGTjoOXTPtn4LfYGvjYX5eBKIucL8Dx1ac63k';

	const parser = new PostalMime.default();
	const rawEmail = new Response(message.raw);
	const email = await parser.parse(await rawEmail.arrayBuffer());

	// 1. メールのメタデータを取得
	const from = email.from;
	const to = formatAddresses(email.to);
	const cc = formatAddresses(email.cc);
	const bcc = formatAddresses(email.bcc);
	const subject = message.headers.get('subject');
	const body = formatBody(email);

	// Discord Embedsを使って見やすいメッセージを作成
	const embed: DiscordEmbed = {
		title: subject || 'No Subject', // 件名がない場合のフォールバック
		fields: [
			{ name: 'From', value: `${from.name} ${from.address}` || 'N/A', inline: true },
			{ name: 'To', value: to, inline: true },
			{ name: 'CC', value: cc, inline: true },
			{ name: 'BCC', value: bcc, inline: true },
		],
		description: body,
		color: 3447003, // Blue color
	};

	const discordPayload = {
		embeds: [embed],
	};

	for (const webhookUrl of webhookUrls) {
		// fetchリクエストを送信
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(discordPayload),
		});

		if (!response.ok) {
			console.error(`Failed to send Discord notification to ${webhookUrl}: ${response.status} ${response.statusText}`);
			const errorText = await response.text();
			console.error(`Discord API response: ${errorText}`);
		}
	}
};

const formatAddresses = (addresses: PostalMime.Address[] | undefined): string => {
	if (!addresses || addresses.length === 0) {
		return 'N/A';
	}
	return addresses.map((addr) => `${addr.name} <${addr.address}>`).join(', ');
};

const formatBody = (email: PostalMime.Email): string => {
	let body = email.text || email.html || '(本文なし)';
	if (body.length > 3000) {
		body = body.substring(0, 3000) + '... ';
	}
	return body;
};
