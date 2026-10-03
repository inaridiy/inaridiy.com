import assert from "node:assert/strict";
import test from "node:test";
import {
	createEmailDeliveryMessage,
	isEmailDeliveryMessage,
} from "emdash-plugin-email-sender/queue";

test("email queue messages use a versioned validated envelope", () => {
	const message = createEmailDeliveryMessage({
		id: "delivery-1",
		enqueuedAt: "2026-07-19T00:00:00.000Z",
		source: "newsletter",
		to: "reader@example.com",
		from: { email: "noreply@inaridiy.com", name: "inaridiy.com" },
		subject: "Subject",
		text: "Body",
	});
	assert.equal(isEmailDeliveryMessage(message), true);
	assert.equal(isEmailDeliveryMessage({ ...message, version: 2 }), false);
	assert.equal(isEmailDeliveryMessage({ ...message, to: "" }), false);
});
