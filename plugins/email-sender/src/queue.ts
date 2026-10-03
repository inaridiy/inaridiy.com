export interface EmailDeliveryMessage {
	version: 1;
	id: string;
	enqueuedAt: string;
	source: string;
	to: string;
	from: {
		email: string;
		name?: string;
	};
	subject: string;
	text: string;
	html?: string;
}

type EmailDeliveryInput = Omit<EmailDeliveryMessage, "version" | "id" | "enqueuedAt"> & {
	id?: string;
	enqueuedAt?: string;
};

export function createEmailDeliveryMessage(input: EmailDeliveryInput): EmailDeliveryMessage {
	return {
		...input,
		version: 1,
		id: input.id ?? crypto.randomUUID(),
		enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isEmailDeliveryMessage(value: unknown): value is EmailDeliveryMessage {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.from)) return false;
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.enqueuedAt === "string" &&
		typeof value.source === "string" &&
		typeof value.to === "string" &&
		value.to.length > 0 &&
		typeof value.from.email === "string" &&
		value.from.email.length > 0 &&
		(value.from.name === undefined || typeof value.from.name === "string") &&
		typeof value.subject === "string" &&
		typeof value.text === "string" &&
		(value.html === undefined || typeof value.html === "string")
	);
}
