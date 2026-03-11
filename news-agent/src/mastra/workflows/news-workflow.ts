import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { exaSearchTool } from '../tools/exa-search-tool';
import { browserbaseTool } from '../tools/browserbase-tool';
import { tavilySearchTool } from '../tools/tavily-search-tool';
import { scoreArticlesBatch } from '../scorers/news-scorer';
import { scoreNewsletter } from '../scorers/newsletter-quality-scorer';

const articleSchema = z.object({
  title: z.string(),
  url: z.string(),
  publishedDate: z.string().optional(),
  summary: z.string(),
  source: z.string().optional(),
  author: z.string().optional(),
});

const scoredArticleSchema = articleSchema.extend({
  score: z.number(),
  timeliness: z.number(),
  novelty: z.number(),
  urgency: z.number(),
});

const sectionSchema = z.object({
  name: z.string(),
  theme: z.string(),
  articles: z.array(scoredArticleSchema),
});

type Article = z.infer<typeof articleSchema>;

// Helper to safely extract articles from tool result (handles ValidationError union)
function extractArticles(result: any): any[] {
  if (result && 'articles' in result) return result.articles;
  return [];
}

// Schema for the quality-scored newsletter output
const qualityScoredOutputSchema = z.object({
  markdown: z.string(),
  filePath: z.string(),
  qualityScore: z.number(),
  topic: z.string(),
  refinedTopic: z.string(),
  strengths: z.string(),
  weaknesses: z.string(),
});

// Step 1a: Search with Exa
const exaSearchStep = createStep({
  id: 'exa-search',
  description: 'Search for news articles using Exa',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema) }),
  execute: async ({ inputData }) => {
    const ctx = {} as any;
    const [result1, result2] = await Promise.all([
      exaSearchTool.execute!({ query: `${inputData.topic} latest news`, numResults: 10 }, ctx),
      exaSearchTool.execute!({ query: `${inputData.topic} breaking`, numResults: 10 }, ctx),
    ]);

    const allArticles = [...extractArticles(result1), ...extractArticles(result2)];

    const seen = new Set<string>();
    const unique = allArticles.filter((a: Article) => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });

    return { articles: unique };
  },
});

// Step 1b: Search with Browserbase
const browserbaseSearchStep = createStep({
  id: 'browserbase-search',
  description: 'Browse news sites using Browserbase',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema) }),
  execute: async ({ inputData }) => {
    const encodedTopic = encodeURIComponent(inputData.topic);
    const urls = [
      `https://news.google.com/search?q=${encodedTopic}&hl=en-US&gl=US&ceid=US:en`,
      `https://www.reuters.com/search/news?query=${encodedTopic}`,
      `https://apnews.com/search?q=${encodedTopic}`,
    ];

    const ctx = {} as any;
    const result = await browserbaseTool.execute!({ urls }, ctx);
    const rawArticles = extractArticles(result);
    const articles = rawArticles.map((a: any) => ({
      title: a.title,
      url: a.url,
      summary: a.content?.slice(0, 500) || '',
      source: new URL(a.url).hostname,
      publishedDate: a.scrapedAt,
    }));

    return { articles };
  },
});

// Step 1c: Search with Tavily
const tavilySearchStep = createStep({
  id: 'tavily-search',
  description: 'Search for news articles using Tavily',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema) }),
  execute: async ({ inputData }) => {
    const ctx = {} as any;
    const result = await tavilySearchTool.execute!(
      { query: `${inputData.topic} news`, maxResults: 10 },
      ctx,
    );

    return { articles: extractArticles(result) };
  },
});

// Step 2: Merge and deduplicate results
const mergeResultsStep = createStep({
  id: 'merge-results',
  description: 'Merge and deduplicate articles from all search sources',
  inputSchema: z.object({
    'exa-search': z.object({ articles: z.array(articleSchema) }),
    'browserbase-search': z.object({ articles: z.array(articleSchema) }),
    'tavily-search': z.object({ articles: z.array(articleSchema) }),
  }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    const allArticles = [
      ...(inputData['exa-search']?.articles || []),
      ...(inputData['browserbase-search']?.articles || []),
      ...(inputData['tavily-search']?.articles || []),
    ];

    // Deduplicate by URL
    const seen = new Set<string>();
    const unique = allArticles.filter((a) => {
      const normalizedUrl = a.url.replace(/\/$/, '').toLowerCase();
      if (seen.has(normalizedUrl)) return false;
      seen.add(normalizedUrl);
      return true;
    });

    return { articles: unique, topic: '' };
  },
});

// Step 3: Score articles
const scoreArticlesStep = createStep({
  id: 'score-articles',
  description: 'Score articles on timeliness, novelty, and urgency',
  inputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    scoredArticles: z.array(scoredArticleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    const { articles, topic } = inputData;
    const scoredArticles: z.infer<typeof scoredArticleSchema>[] = [];

    // Score in batches of 5
    for (let i = 0; i < articles.length; i += 5) {
      const batch = articles.slice(i, i + 5);
      const scores = await scoreArticlesBatch(batch, topic);

      for (let j = 0; j < batch.length; j++) {
        const article = batch[j];
        const scoreData = scores[j] || { timeliness: 0.5, novelty: 0.5, urgency: 0.5, score: 0.5 };
        scoredArticles.push({
          ...article,
          ...scoreData,
        });
      }
    }

    // Sort by score descending, keep top 20
    scoredArticles.sort((a, b) => b.score - a.score);
    const topArticles = scoredArticles.slice(0, 20);

    return { scoredArticles: topArticles, topic };
  },
});

// Step 4: Organize into themed sections
const organizeStoriesStep = createStep({
  id: 'organize-stories',
  description: 'Organize scored articles into themed sections with creative subheaders',
  inputSchema: z.object({
    scoredArticles: z.array(scoredArticleSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    sections: z.array(sectionSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('newsOrganizerAgent');
    if (!agent) throw new Error('News organizer agent not found');

    const articleList = inputData.scoredArticles
      .map(
        (a, i) =>
          `[${i}] "${a.title}" (score: ${a.score.toFixed(2)}) - ${a.summary.slice(0, 200)}`,
      )
      .join('\n');

    const outputSchema = z.object({
      sections: z.array(
        z.object({
          name: z.string(),
          theme: z.string(),
          articleIndices: z.array(z.number()),
        }),
      ),
    });

    const response = await agent.generate(
      [
        {
          role: 'user' as const,
          content: `Organize these ${inputData.scoredArticles.length} articles about "${inputData.topic}" into 3-4 themed sections. Each section needs a descriptive name and a creative, witty subheader.

Articles:
${articleList}

Return a JSON object with this structure:
{
  "sections": [
    {
      "name": "Section Name",
      "theme": "Creative witty subheader here",
      "articleIndices": [0, 1, 2]
    }
  ]
}

Every article index must appear in exactly one section.`,
        },
      ],
      {
        structuredOutput: {
          schema: outputSchema,
        },
      },
    );

    const organized = (response.object?.sections || []).map((section) => ({
      name: section.name,
      theme: section.theme,
      articles: (section.articleIndices || [])
        .filter((idx) => idx < inputData.scoredArticles.length)
        .map((idx) => inputData.scoredArticles[idx]),
    }));

    return { sections: organized, topic: inputData.topic };
  },
});

// Step 5: Write the newsletter
const writeNewsletterStep = createStep({
  id: 'write-newsletter',
  description: 'Compile the final markdown newsletter and write to file',
  inputSchema: z.object({
    sections: z.array(sectionSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    topic: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const agent = mastra?.getAgent('newsletterWriterAgent');
    if (!agent) throw new Error('Newsletter writer agent not found');

    const sectionsText = inputData.sections
      .map((s) => {
        const articleDetails = s.articles
          .map(
            (a) =>
              `- "${a.title}" | URL: ${a.url} | Source: ${a.source || 'unknown'} | Score: ${a.score.toFixed(2)}\n  Summary: ${a.summary.slice(0, 300)}`,
          )
          .join('\n');
        return `## ${s.name}\n*${s.theme}*\n\n${articleDetails}`;
      })
      .join('\n\n');

    const today = new Date().toISOString().split('T')[0];
    const topicSlug = inputData.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const fileName = `${topicSlug}-${today}.md`;

    const response = await agent.generate([
      {
        role: 'user' as const,
        content: `Write a complete markdown newsletter about "${inputData.topic}" for ${today}.

Here are the organized sections with articles:

${sectionsText}

Requirements:
- Start with a catchy title (# heading)
- Include the date
- Write a brief intro paragraph about the topic
- For each section, use the section name as ## heading and the theme as an italic subtitle
- For each article, write a 2-3 sentence summary and include a [Source](url) link
- End with a witty sign-off
- The newsletter should be professional, engaging, and informative

After writing the newsletter content, use the write-file tool to save it with the filename "${fileName}".`,
      },
    ]);

    const markdown = response.text || '';

    return { markdown, filePath: `./reports/${fileName}`, topic: inputData.topic };
  },
});

// Step 6: Score the newsletter quality (1-10 expert review)
const scoreNewsletterStep = createStep({
  id: 'score-newsletter',
  description: 'Score the newsletter quality on a 1-10 scale from a subject matter expert perspective',
  inputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    topic: z.string(),
  }),
  outputSchema: qualityScoredOutputSchema,
  execute: async ({ inputData }) => {
    const evaluation = await scoreNewsletter(inputData.markdown, inputData.topic);

    console.log(`\n📊 Newsletter Quality Score: ${evaluation.overallScore}/10`);
    console.log(`   Strengths: ${evaluation.strengths}`);
    console.log(`   Weaknesses: ${evaluation.weaknesses}`);
    if (evaluation.overallScore < 6) {
      console.log(`   ⚠️  Score below 6 — will retry with refined topic: "${evaluation.improvementSuggestion}"`);
    }

    return {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: evaluation.overallScore,
      topic: inputData.topic,
      refinedTopic: evaluation.improvementSuggestion || inputData.topic,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
    };
  },
});

// Branch A: Newsletter passes quality check (score >= 6) — return as-is
const passQualityStep = createStep({
  id: 'pass-quality',
  description: 'Newsletter passed quality check, return final result',
  inputSchema: qualityScoredOutputSchema,
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
  execute: async ({ inputData }) => {
    console.log(`\n✅ Newsletter passed quality check with score ${inputData.qualityScore}/10`);
    return {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: inputData.qualityScore,
    };
  },
});

// Branch B: Newsletter fails quality check (score < 6) — re-run entire pipeline with refined topic
const retryPipelineStep = createStep({
  id: 'retry-pipeline',
  description: 'Re-run the entire news pipeline with a refined, more detailed topic',
  inputSchema: qualityScoredOutputSchema,
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
  execute: async ({ inputData, mastra }) => {
    const refinedTopic = inputData.refinedTopic;
    console.log(`\n🔄 Retrying pipeline with refined topic: "${refinedTopic}"`);
    console.log(`   Original topic: "${inputData.topic}"`);
    console.log(`   Previous score: ${inputData.qualityScore}/10`);
    console.log(`   Reason: ${inputData.weaknesses}`);

    // --- Re-run the full pipeline inline with the refined topic ---

    // 1. Parallel searches with refined topic
    const ctx = {} as any;
    const [exaResult1, exaResult2, tavilyResult, bbResult] = await Promise.all([
      exaSearchTool.execute!({ query: `${refinedTopic} latest news`, numResults: 10 }, ctx),
      exaSearchTool.execute!({ query: `${refinedTopic} breaking`, numResults: 10 }, ctx),
      tavilySearchTool.execute!({ query: `${refinedTopic} news`, maxResults: 10 }, ctx),
      browserbaseTool.execute!({
        urls: [
          `https://news.google.com/search?q=${encodeURIComponent(refinedTopic)}&hl=en-US&gl=US&ceid=US:en`,
          `https://www.reuters.com/search/news?query=${encodeURIComponent(refinedTopic)}`,
          `https://apnews.com/search?q=${encodeURIComponent(refinedTopic)}`,
        ],
      }, ctx),
    ]);

    // Merge all results
    const allArticles = [
      ...extractArticles(exaResult1),
      ...extractArticles(exaResult2),
      ...extractArticles(tavilyResult),
      ...extractArticles(bbResult).map((a: any) => ({
        title: a.title,
        url: a.url,
        summary: a.content?.slice(0, 500) || '',
        source: new URL(a.url).hostname,
        publishedDate: a.scrapedAt,
      })),
    ];

    // Deduplicate
    const seen = new Set<string>();
    const uniqueArticles = allArticles.filter((a: any) => {
      const normalizedUrl = a.url?.replace(/\/$/, '').toLowerCase();
      if (!normalizedUrl || seen.has(normalizedUrl)) return false;
      seen.add(normalizedUrl);
      return true;
    });

    // 2. Score articles
    const scoredArticles: z.infer<typeof scoredArticleSchema>[] = [];
    for (let i = 0; i < uniqueArticles.length; i += 5) {
      const batch = uniqueArticles.slice(i, i + 5);
      const scores = await scoreArticlesBatch(batch, refinedTopic);
      for (let j = 0; j < batch.length; j++) {
        const scoreData = scores[j] || { timeliness: 0.5, novelty: 0.5, urgency: 0.5, score: 0.5 };
        scoredArticles.push({ ...batch[j], ...scoreData });
      }
    }
    scoredArticles.sort((a, b) => b.score - a.score);
    const topArticles = scoredArticles.slice(0, 20);

    // 3. Organize into sections
    const organizerAgent = mastra?.getAgent('newsOrganizerAgent');
    if (!organizerAgent) throw new Error('News organizer agent not found');

    const articleListText = topArticles
      .map((a, i) => `[${i}] "${a.title}" (score: ${a.score.toFixed(2)}) - ${a.summary.slice(0, 200)}`)
      .join('\n');

    const orgResponse = await organizerAgent.generate(
      [{
        role: 'user' as const,
        content: `Organize these ${topArticles.length} articles about "${refinedTopic}" into 3-4 themed sections. Each section needs a descriptive name and a creative, witty subheader.

Articles:
${articleListText}

Return a JSON object with this structure:
{
  "sections": [{ "name": "Section Name", "theme": "Creative witty subheader", "articleIndices": [0, 1, 2] }]
}

Every article index must appear in exactly one section.`,
      }],
      {
        structuredOutput: {
          schema: z.object({
            sections: z.array(z.object({
              name: z.string(),
              theme: z.string(),
              articleIndices: z.array(z.number()),
            })),
          }),
        },
      },
    );

    const sections = (orgResponse.object?.sections || []).map((section) => ({
      name: section.name,
      theme: section.theme,
      articles: (section.articleIndices || [])
        .filter((idx) => idx < topArticles.length)
        .map((idx) => topArticles[idx]),
    }));

    // 4. Write newsletter
    const writerAgent = mastra?.getAgent('newsletterWriterAgent');
    if (!writerAgent) throw new Error('Newsletter writer agent not found');

    const sectionsText = sections
      .map((s) => {
        const details = s.articles
          .map((a) => `- "${a.title}" | URL: ${a.url} | Source: ${a.source || 'unknown'} | Score: ${a.score.toFixed(2)}\n  Summary: ${a.summary.slice(0, 300)}`)
          .join('\n');
        return `## ${s.name}\n*${s.theme}*\n\n${details}`;
      })
      .join('\n\n');

    const today = new Date().toISOString().split('T')[0];
    const topicSlug = refinedTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const fileName = `${topicSlug}-${today}-retry.md`;

    const writeResponse = await writerAgent.generate([{
      role: 'user' as const,
      content: `Write a complete markdown newsletter about "${refinedTopic}" for ${today}.

Here are the organized sections with articles:

${sectionsText}

Requirements:
- Start with a catchy title (# heading)
- Include the date
- Write a brief intro paragraph about the topic
- For each section, use the section name as ## heading and the theme as an italic subtitle
- For each article, write a 2-3 sentence summary and include a [Source](url) link
- End with a witty sign-off
- The newsletter should be professional, engaging, and informative
- This is a RETRY — the previous version scored ${inputData.qualityScore}/10. Weaknesses were: ${inputData.weaknesses}. Make sure to address these.

After writing the newsletter content, use the write-file tool to save it with the filename "${fileName}".`,
    }]);

    const retryMarkdown = writeResponse.text || '';

    // 5. Score the retry
    const retryEvaluation = await scoreNewsletter(retryMarkdown, refinedTopic);
    console.log(`\n📊 Retry Newsletter Quality Score: ${retryEvaluation.overallScore}/10`);

    return {
      markdown: retryMarkdown,
      filePath: `./reports/${fileName}`,
      qualityScore: retryEvaluation.overallScore,
    };
  },
});

// Assemble the workflow
const newsWorkflow = createWorkflow({
  id: 'news-workflow',
  inputSchema: z.object({
    topic: z.string().describe('The news topic to research and report on'),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
})
  .parallel([exaSearchStep, browserbaseSearchStep, tavilySearchStep])
  .then(mergeResultsStep)
  .then(scoreArticlesStep)
  .then(organizeStoriesStep)
  .then(writeNewsletterStep)
  .then(scoreNewsletterStep)
  .branch([
    [
      async ({ inputData }) => (inputData as any).qualityScore >= 6,
      passQualityStep,
    ],
    [
      async ({ inputData }) => (inputData as any).qualityScore < 6,
      retryPipelineStep,
    ],
  ]);

newsWorkflow.commit();

export { newsWorkflow };
