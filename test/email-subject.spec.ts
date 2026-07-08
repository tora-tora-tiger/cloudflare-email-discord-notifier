import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import { formatEmailSubject } from "../src/index";

describe("email subject formatting", () => {
	it("uses decoded MIME encoded-word subject", async () => {
		const parser = new PostalMime();
		const email = await parser.parse(
			[
				"From: Sender <sender@example.com>",
				"To: Receiver <receiver@example.com>",
				"Subject: =?utf-8?b?SW5jcmVhc2VkIGNvbmN1cnJlbmN5IGZvciBzZXJ2aWNlIHVzZXJz?=",
				"",
				"Body",
			].join("\r\n"),
		);

		expect(formatEmailSubject(email)).toBe(
			"Increased concurrency for service users",
		);
	});

	it("returns default text when subject is missing", () => {
		expect(
			formatEmailSubject({
				headers: [],
				from: { name: "", address: "sender@example.com" },
				messageId: "",
				attachments: [],
			}),
		).toBe("No Subject");
	});
});
