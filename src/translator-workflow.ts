import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	cleanTranslatedSegment,
	isRecord,
	MAX_INPUT_CHARS,
	readChoiceContent,
	readProviderMetadata,
	SYSTEM_PROMPT,
	TRANSLATOR_API,
	type CompleteResponse,
	type PlanResponse,
	type ProviderMetadata,
	type TranslationJobParams,
} from "emdash-plugin-translator/translate";

/**
 * Durable JA->EN translation job. The auto-translator plugin's
 * afterSave/afterPublish hook enqueues one instance per changed entry;
 * every model call is its own retryable step, and the entry is only
 * touched through the plugin's `plan`/`complete` callback routes (via the
 * SELF service binding), so the English entry is written inside the plugin
 * bridge and its own content hooks (aiSearch, cache purge) fire normally.
 *
 * The hooks themselves must stay this thin: hook chains run in the
 * request's waitUntil, which Workers cancels ~30s after the response.
 */

const CANONICAL_ORIGIN = "https://inaridiy.com";

/** Finish reasons that will not improve on retry. */
const PERMANENT_FINISH_REASONS = new Set(["content_filter", "safety", "length", "max_tokens"]);

const CALLBACK_STEP = {
	retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
	timeout: "30 seconds",
} as const;

const MODEL_STEP = {
	retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
	timeout: "2 minutes",
} as const;

interface SegmentResult {
	translation: string;
	metadata: ProviderMetadata;
}

export class TranslatorWorkflow extends WorkflowEntrypoint<Env, TranslationJobParams> {
	async run(event: WorkflowEvent<TranslationJobParams>, step: WorkflowStep) {
		const job = event.payload;

		const plan = await step.do("fetch-plan", CALLBACK_STEP, () =>
			this.callPlugin<PlanResponse>(TRANSLATOR_API.plan, job),
		);
		if (!plan.ok) {
			if (plan.unauthorized) {
				throw new NonRetryableError("auto-translator rejected the callback secret");
			}
			// Entry unpublished or source changed since enqueue; the plugin
			// already released the lease and a newer job owns the entry.
			return { outcome: "stale" };
		}

		const usage = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
		try {
			const translations: string[] = [];
			for (const [index, segment] of plan.batch.entries()) {
				if (segment.length > MAX_INPUT_CHARS) {
					throw new NonRetryableError(
						`Translation segment exceeds the ${MAX_INPUT_CHARS}-character input budget`,
					);
				}
				const result = await step.do(
					`translate-segment-${index + 1}-of-${plan.batch.length}`,
					MODEL_STEP,
					() => this.translateSegment(segment, plan.model, plan.gatewayId),
				);
				translations.push(result.translation);
				usage.calls += 1;
				usage.promptTokens += result.metadata.usage?.promptTokens ?? 0;
				usage.completionTokens += result.metadata.usage?.completionTokens ?? 0;
				usage.totalTokens += result.metadata.usage?.totalTokens ?? 0;
			}

			const completed = await step.do("write-back", CALLBACK_STEP, () =>
				this.callPlugin<CompleteResponse>(TRANSLATOR_API.complete, {
					...job,
					translations,
					providerRuns: [aggregateMetadata(usage)],
				}),
			);
			return {
				outcome: completed.ok ? "translated" : (completed.reason ?? "discarded"),
				segments: plan.batch.length,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Record the failure through the plugin (clears stale targets,
			// writes state:last, releases the lease) before erroring the
			// instance so the dashboard shows it as failed.
			await step.do("record-failure", CALLBACK_STEP, async () => {
				await this.callPlugin<CompleteResponse>(TRANSLATOR_API.complete, {
					...job,
					error: message,
					providerRuns: usage.calls > 0 ? [aggregateMetadata(usage)] : [],
				});
			});
			throw error instanceof NonRetryableError ? error : new NonRetryableError(message);
		}
	}

	/** POST to an auto-translator callback route through the SELF binding. */
	private async callPlugin<T>(path: string, body: unknown): Promise<T> {
		const response = await this.env.SELF.fetch(`${CANONICAL_ORIGIN}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			throw new Error(`auto-translator route ${path} returned HTTP ${response.status}`);
		}
		const parsed: unknown = await response.json();
		if (!isRecord(parsed) || parsed.data === undefined) {
			throw new Error(`auto-translator route ${path} returned no data envelope`);
		}
		return parsed.data as T;
	}

	/** One Workers AI call translating one Portable Text segment. */
	private async translateSegment(
		text: string,
		model: string,
		gatewayId: string,
	): Promise<SegmentResult> {
		const ai = this.env.AI;
		if (!ai) throw new NonRetryableError("Workers AI binding (AI) is not available");
		const result = await ai.run(
			model as Parameters<Ai["run"]>[0],
			{
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: text },
				],
				temperature: 0.2,
				max_tokens: 2048,
				// Gemma 4 is a reasoning model and, left thinking, burns the whole
				// max_tokens budget on reasoning_content — finish_reason "length"
				// with empty content. Translation needs no chain of thought.
				chat_template_kwargs: { enable_thinking: false },
			},
			gatewayId ? { gateway: { id: gatewayId } } : undefined,
		);
		const record = isRecord(result) ? result : {};
		const metadata = readProviderMetadata(record);
		// Depending on the model, Workers AI returns either the legacy
		// { response } shape or an OpenAI-style chat completions envelope.
		const reply =
			typeof record.response === "string"
				? record.response
				: readChoiceContent(record.choices);
		if (typeof reply !== "string" || reply.trim() === "") {
			throw new Error(
				`Workers AI reply has no response text: ${JSON.stringify(record).slice(0, 300)}`,
			);
		}
		if (
			metadata.finishReason &&
			PERMANENT_FINISH_REASONS.has(metadata.finishReason.toLowerCase())
		) {
			throw new NonRetryableError(
				`Workers AI reply was incomplete (${metadata.finishReason})`,
			);
		}
		return { translation: cleanTranslatedSegment(text, reply), metadata };
	}
}

/** Collapse per-segment usage into the single run record the admin page shows. */
function aggregateMetadata(usage: {
	calls: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}): ProviderMetadata {
	return {
		shape: "chat",
		usage: {
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			totalTokens: usage.totalTokens,
		},
	};
}
