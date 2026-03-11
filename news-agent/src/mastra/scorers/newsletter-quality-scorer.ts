import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import {
  getAssistantMessageFromRunOutput,
  getUserMessageFromRunInput,
} from '@mastra/evals/scorers/utils';

export const newsletterQualityScorer = createScorer({
  id: 'newsletter-quality-scorer',
  name: 'Newsletter Quality',
  description:
    'Evaluates newsletter quality on a 1-10 scale from a subject matter expert perspective',
  type: 'agent',
  judge: {
    model: 'openai/gpt-5-mini',
    instructions:
      'You are a veteran newsletter editor and subject matter expert. ' +
      'You evaluate newsletters with high standards for content quality, writing style, ' +
      'informativeness, and reader engagement. Be critical but fair.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    return { userText, assistantText };
  })
  .analyze({
    description: 'Evaluate newsletter quality on multiple dimensions',
    outputSchema: z.object({
      contentDepth: z.number().min(1).max(10),
      writingQuality: z.number().min(1).max(10),
      sourceVariety: z.number().min(1).max(10),
      engagement: z.number().min(1).max(10),
      overallScore: z.number().min(1).max(10),
      strengths: z.string(),
      weaknesses: z.string(),
      improvementSuggestion: z.string(),
    }),
    createPrompt: ({ results }) => `
      You are reviewing a newsletter as a subject matter expert. Rate it on a 1-10 scale.

      Newsletter content:
      """
      ${results.preprocessStepResult.assistantText}
      """

      Original topic/request:
      """
      ${results.preprocessStepResult.userText}
      """

      Evaluate on these dimensions (1-10 each):
      - contentDepth: Are articles well-summarized with meaningful context? Do they go beyond surface-level?
      - writingQuality: Is the prose clear, engaging, and professional? Good transitions between sections?
      - sourceVariety: Are sources diverse (not all from one outlet)? Are they reputable?
      - engagement: Would a reader find this interesting? Are the section themes/subheaders creative?

      Also provide:
      - overallScore: Your overall quality rating (1-10). A 6 means "acceptable for publication."
        Below 6 means it needs significant improvement. Above 7 means genuinely good.
      - strengths: What the newsletter does well (1-2 sentences)
      - weaknesses: What could be improved (1-2 sentences)
      - improvementSuggestion: If overallScore < 6, suggest how to refine the topic for a better result

      Return JSON matching the schema.
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    // Normalize 1-10 to 0-1 for Mastra's scorer framework
    return (r.overallScore ?? 5) / 10;
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `Newsletter quality: ${r.overallScore ?? 'N/A'}/10. Strengths: ${r.strengths ?? 'N/A'}. Weaknesses: ${r.weaknesses ?? 'N/A'}.`;
  });

// Standalone function for use in workflow steps
export async function scoreNewsletter(
  markdown: string,
  topic: string,
): Promise<{
  overallScore: number;
  contentDepth: number;
  writingQuality: number;
  sourceVariety: number;
  engagement: number;
  strengths: string;
  weaknesses: string;
  improvementSuggestion: string;
}> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a veteran newsletter editor and subject matter expert. ' +
            'Evaluate the newsletter on a 1-10 scale. Be critical but fair. ' +
            'A 6 means "acceptable for publication." Below 6 needs significant improvement. ' +
            'Return JSON with: contentDepth (1-10), writingQuality (1-10), sourceVariety (1-10), ' +
            'engagement (1-10), overallScore (1-10), strengths (string), weaknesses (string), ' +
            'improvementSuggestion (string - if overallScore < 6, suggest a more specific/interesting ' +
            'version of the topic that would yield a better newsletter).',
        },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nNewsletter:\n${markdown}`,
        },
      ],
    }),
  });

  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);

  return {
    overallScore: parsed.overallScore ?? 5,
    contentDepth: parsed.contentDepth ?? 5,
    writingQuality: parsed.writingQuality ?? 5,
    sourceVariety: parsed.sourceVariety ?? 5,
    engagement: parsed.engagement ?? 5,
    strengths: parsed.strengths ?? '',
    weaknesses: parsed.weaknesses ?? '',
    improvementSuggestion: parsed.improvementSuggestion ?? '',
  };
}
