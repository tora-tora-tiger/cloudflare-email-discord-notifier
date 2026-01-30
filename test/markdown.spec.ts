import { describe, expect, it } from "vitest";
import { chunkForDiscord, fixMarkdownFormatting } from "../src/index";

describe("markdown/url fixes", () => {
	it("converts empty markdown link to plain URL with spaces", () => {
		const input = "before[](https://example.com/a\nb)after";
		const fixed = fixMarkdownFormatting(input);
		expect(fixed).toContain("before https://example.com/ab after");
	});

	it("removes dash separator lines (including list form)", () => {
		const input = ["-----", "- -----", "text"].join("\n");
		const fixed = fixMarkdownFormatting(input);
		expect(fixed).toContain("text");
		expect(fixed).not.toMatch(/^-{3,}$/m);
		expect(fixed).not.toMatch(/^\s*-\s*-{3,}\s*$/m);
	});

	it('removes broken link residue "](" and keeps URL', () => {
		const input = "hello\n](https://example.com/path)\nworld\n";
		const fixed = fixMarkdownFormatting(input);
		expect(fixed).toContain("https://example.com/path");
		expect(fixed).not.toContain("](");
	});

	it('removes "](" line-start residues and stray brackets', () => {
		const input = [
			"[](https://example.com/one)",
			"](https://example.com/two) [",
			"](https://example.com/three) [",
		].join("\n");
		const fixed = fixMarkdownFormatting(input);
		expect(fixed).toContain("https://example.com/one");
		expect(fixed).toContain("https://example.com/two");
		expect(fixed).toContain("https://example.com/three");
		expect(fixed).not.toContain("](");
		expect(fixed).not.toMatch(/(^|[\s\r\n])\[(?=[\s\r\n]|$)/);
	});

	it('removes "! " residue before URLs', () => {
		const fixed = fixMarkdownFormatting(
			"ok!\n! https://example.com/a\nwow! https://example.com/b",
		);
		expect(fixed).toContain("https://example.com/a");
		expect(fixed).toContain("https://example.com/b");
		expect(fixed).not.toContain("! https://");
	});

	it("does not split a URL across discord chunks", () => {
		const url =
			"https://example.com/this/is/a/very/long/path?with=query&and=more";
		const input = `prefix ${"x".repeat(50)} ${url} ${"y".repeat(50)} suffix`;
		const chunks = chunkForDiscord(input, 80);
		const containing = chunks.filter((c) => c.includes("https://example.com/"));
		expect(containing).toHaveLength(1);
		expect(containing[0]).toContain(url);
	});
});
