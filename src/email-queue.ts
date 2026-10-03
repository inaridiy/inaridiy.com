import {
	isEmailDeliveryMessage,
	type EmailDeliveryMessage,
} from "emdash-plugin-email-sender/queue";

function retryDelaySeconds(attempts: number): number {
	return Math.min(300, 5 * 2 ** Math.min(Math.max(attempts - 1, 0), 6));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function deliverEmailBatch(
	batch: MessageBatch<unknown>,
	email: SendEmail,
): Promise<void> {
	for (const message of batch.messages) {
		if (!isEmailDeliveryMessage(message.body)) {
			console.error({
				event: "email_queue_invalid_message",
				queueMessageId: message.id,
			});
			message.ack();
			continue;
		}

		const delivery: EmailDeliveryMessage = message.body;
		try {
			await email.send({
				to: delivery.to,
				from: delivery.from.name
					? { email: delivery.from.email, name: delivery.from.name }
					: delivery.from.email,
				subject: delivery.subject,
				text: delivery.text,
				html: delivery.html,
			});
			message.ack();
			console.info({
				event: "email_queue_delivered",
				deliveryId: delivery.id,
				source: delivery.source,
			});
		} catch (error) {
			const delaySeconds = retryDelaySeconds(message.attempts);
			console.error({
				event: "email_queue_delivery_failed",
				deliveryId: delivery.id,
				source: delivery.source,
				attempts: message.attempts,
				delaySeconds,
				error: errorMessage(error),
			});
			message.retry({ delaySeconds });
		}
	}
}
