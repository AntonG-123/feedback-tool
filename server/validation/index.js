// Validation service with a swappable provider.
//
//   rules     - deterministic engine in shared/validation.js (always available)
//   anthropic - Claude classifies the feedback (structured JSON output). On any
//               error or timeout the result falls back to the rules engine
//               and says so (`provider: 'rules', fallback: true`) - a provider
//               failure never turns into an automatic "valid".
import { z } from 'zod';
import { validateFeedback } from '../../shared/validation.js';
import { config } from '../config.js';

const LlmResult = z.object({
  actionable: z.boolean(),
  category: z.enum(['image', 'text', 'color', 'typography', 'size', 'spacing', 'position', 'layout', 'link', 'functional', 'add', 'remove', 'dislike', 'approval', 'question', 'general', 'unclear']),
  missing: z.array(z.string()),
  questions: z.array(z.string()),
  needs_image_attachment: z.boolean(),
});

const SYSTEM = `You review website feedback comments before they are sent to a web designer/developer.
Decide whether the comment contains enough information to act on without asking back.
The comment is pinned to a specific element on the page, so "this"/"here" identifies WHERE, but not WHAT should change or HOW.
Rules:
- Vague requests ("adjust it", "make it better", "change the color", "move this", "fix this button") are NOT actionable: ask what exactly, which value, where to, what is wrong and what should happen instead.
- Image replacement needs the new image (attached or clearly described). If an image is attached, never ask for one again.
- Rewording needs the new wording or a clear direction (shorter, more formal, ...).
- Praise/approval and clear questions are actionable.
- Questions must be specific to the comment, short, in the language of the comment, max 3. Return no questions when actionable.`;

let client;
async function anthropicValidate(input) {
  if (!client) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic({ apiKey: config.validation.anthropicApiKey, maxRetries: 0, timeout: config.validation.timeoutMs });
  }
  const { zodOutputFormat } = await import('@anthropic-ai/sdk/helpers/zod');
  // Only the comment text, attachment counts and the element type are sent -
  // no page content, URLs or personal data.
  const userContent = JSON.stringify({
    comment: input.text,
    attached_images: input.attachments?.images || 0,
    element: { tag: input.element?.tag || null, is_image: !!input.element?.isImage },
  });
  const response = await client.messages.parse({
    model: config.validation.anthropicModel,
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(LlmResult) },
    system: SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });
  if (response.stop_reason === 'refusal') throw new Error('validation model refused');
  const out = response.parsed_output;
  if (!out) throw new Error('validation model returned no parseable output');
  return out;
}

export async function validate(input) {
  const rules = validateFeedback(input);
  if (config.validation.provider !== 'anthropic' || !config.validation.anthropicApiKey) return rules;
  // Hard rule independent of the model: the comment needs text.
  if (rules.category === 'empty' || rules.category === 'unclear' && !String(input.text || '').trim()) return rules;
  try {
    const r = await anthropicValidate(input);
    const needsImage = r.needs_image_attachment && !(input.attachments?.images > 0);
    const actionable = r.actionable && !needsImage;
    const questions = actionable ? [] : r.questions.slice(0, 3);
    if (!actionable && !questions.length) questions.push(...rules.questions, ...(rules.questions.length ? [] : ['Could you describe more specifically what should change and how?']));
    return {
      actionable, canSubmit: actionable, category: r.category, missing: actionable ? [] : r.missing,
      questions, requiredAttachments: needsImage ? ['image'] : [], provider: 'anthropic',
    };
  } catch (e) {
    console.warn('[validation] provider failed, using rules:', e.message);
    return { ...rules, fallback: true };
  }
}
