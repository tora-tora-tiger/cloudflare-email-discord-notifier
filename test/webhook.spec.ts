import { describe, it, expect, vi } from 'vitest';
import { sendDiscordChunks } from '../src/index';

describe('discord webhook sender', () => {
	it('posts each non-empty chunk to each webhook', async () => {
		const fetchFn = vi.fn(async () => new Response('', { status: 204 }));
		const chunks = ['a', '', 'b'];
		const webhooks = ['https://example.com/hook1', 'https://example.com/hook2'];

		await sendDiscordChunks(chunks, webhooks, fetchFn);

		expect(fetchFn).toHaveBeenCalledTimes(4);
		const calls = fetchFn.mock.calls.map(([url, init]) => ({
			url: String(url),
			method: (init as RequestInit | undefined)?.method,
			headers: (init as RequestInit | undefined)?.headers as Record<string, string> | undefined,
			body: (init as RequestInit | undefined)?.body as string | undefined,
		}));

		for (const c of calls) {
			expect(webhooks).toContain(c.url);
			expect(c.method).toBe('POST');
			expect(c.headers?.['Content-Type']).toBe('application/json');
			const parsed = JSON.parse(c.body ?? '{}') as { content?: string; flags?: number };
			expect(['a', 'b']).toContain(parsed.content);
		}

		const callsByWebhook = new Map<string, { content?: string; flags?: number }[]>();
		for (const c of calls) {
			const parsed = JSON.parse(c.body ?? '{}') as { content?: string; flags?: number };
			const bucket = callsByWebhook.get(c.url) ?? [];
			bucket.push(parsed);
			callsByWebhook.set(c.url, bucket);
		}

		for (const webhook of webhooks) {
			const items = callsByWebhook.get(webhook) ?? [];
			expect(items).toHaveLength(2);
			expect(items[0]?.content).toBe('a');
			expect(items[0]?.flags).toBeUndefined();
			expect(items[1]?.content).toBe('b');
			expect(items[1]?.flags).toBe(4096);
		}
	});
});
