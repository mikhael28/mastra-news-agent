import { z } from 'zod';
import { createScorer } from '@mastra/core/evals';
import {
  getAssistantMessageFromRunOutput,
  getUserMessageFromRunInput,
} from '@mastra/evals/scorers/utils';

export const newsRelevanceScorer = createScorer({
  id: 'news-relevance-scorer',
  name: 'News Relevance',
  description:
    'Evaluates news articles on timeliness, novelty, and urgency',
  type: 'agent',
  judge: {
    model: 'openai/gpt-5-mini',
    instructions:
      'You are an expert news editor who evaluates articles for inclusion in a newsletter. ' +
      'Assess each article on timeliness (how recent), novelty (unique angle vs duplicate coverage), ' +
      'and urgency (breaking/developing news). Return structured JSON.',
  },
})
  .preprocess(({ run }) => {
    const userText = getUserMessageFromRunInput(run.input) || '';
    const assistantText = getAssistantMessageFromRunOutput(run.output) || '';
    return { userText, assistantText };
  })
  .analyze({
    description: 'Evaluate article timeliness, novelty, and urgency',
    outputSchema: z.object({
      timeliness: z.number().min(0).max(1),
      novelty: z.number().min(0).max(1),
      urgency: z.number().min(0).max(1),
      explanation: z.string().default(''),
    }),
    createPrompt: ({ results }) => `
      Evaluate the following news content for newsletter inclusion.

      Content:
      """
      ${results.preprocessStepResult.assistantText}
      """

      Context/Topic:
      """
      ${results.preprocessStepResult.userText}
      """

      Score each factor from 0 to 1:
      - timeliness: How recent is the content? 1.0 = published within hours, 0.5 = within 24h, 0.0 = older than 48h
      - novelty: Does it offer a unique angle? 1.0 = completely new story, 0.5 = new angle on known story, 0.0 = duplicate coverage
      - urgency: Is this breaking/developing? 1.0 = breaking news, 0.5 = developing story, 0.0 = routine coverage

      Return JSON with: { timeliness, novelty, urgency, explanation }
    `,
  })
  .generateScore(({ results }) => {
    const r = (results as any)?.analyzeStepResult || {};
    const timeliness = r.timeliness ?? 0.5;
    const novelty = r.novelty ?? 0.5;
    const urgency = r.urgency ?? 0.5;
    return 0.35 * timeliness + 0.35 * novelty + 0.30 * urgency;
  })
  .generateReason(({ results, score }) => {
    const r = (results as any)?.analyzeStepResult || {};
    return `News relevance: timeliness=${r.timeliness ?? 0}, novelty=${r.novelty ?? 0}, urgency=${r.urgency ?? 0}. Composite=${score}. ${r.explanation ?? ''}`;
  });

// Standalone scoring function for use in workflow steps
export async function scoreArticle(
  article: { title: string; summary: string; publishedDate?: string },
  topic: string,
): Promise<{ timeliness: number; novelty: number; urgency: number; score: number }> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a news editor scoring articles. Return JSON with: timeliness (0-1), novelty (0-1), urgency (0-1). ' +
            'timeliness: 1.0 = just published, 0.0 = old news. novelty: 1.0 = unique angle, 0.0 = duplicate. urgency: 1.0 = breaking, 0.0 = routine.',
        },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nArticle title: ${article.title}\nPublished: ${article.publishedDate || 'unknown'}\nSummary: ${article.summary}`,
        },
      ],
    }),
  });

  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);

  const timeliness = parsed.timeliness ?? 0.5;
  const novelty = parsed.novelty ?? 0.5;
  const urgency = parsed.urgency ?? 0.5;
  const score = 0.35 * timeliness + 0.35 * novelty + 0.30 * urgency;

  return { timeliness, novelty, urgency, score };
}

// Batch scoring: score multiple articles in a single LLM call for efficiency
export async function scoreArticlesBatch(
  articles: Array<{ title: string; summary: string; publishedDate?: string }>,
  topic: string,
): Promise<Array<{ timeliness: number; novelty: number; urgency: number; score: number }>> {
  const articleList = articles
    .map(
      (a, i) =>
        `[${i}] Title: ${a.title}\nPublished: ${a.publishedDate || 'unknown'}\nSummary: ${a.summary}`,
    )
    .join('\n\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a news editor scoring articles for a newsletter. For each article, provide timeliness (0-1), novelty (0-1), urgency (0-1). ' +
            'Return JSON: { "scores": [{ "timeliness": number, "novelty": number, "urgency": number }, ...] } ' +
            'One entry per article, in order.',
        },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nArticles:\n${articleList}`,
        },
      ],
    }),
  });

  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);

  return (parsed.scores || []).map((s: any) => {
    const timeliness = s.timeliness ?? 0.5;
    const novelty = s.novelty ?? 0.5;
    const urgency = s.urgency ?? 0.5;
    return {
      timeliness,
      novelty,
      urgency,
      score: 0.35 * timeliness + 0.35 * novelty + 0.30 * urgency,
    };
  });
}
