import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Mastra } from '@mastra/core/mastra';
import { exaSearchTool } from '../tools/exa-search-tool';
import { browserbaseTool } from '../tools/browserbase-tool';
import { tavilySearchTool } from '../tools/tavily-search-tool';
import { writeFileTool } from '../tools/write-file-tool';
import { scoreArticlesBatch } from '../scorers/news-scorer';
import { scoreNewsletter } from '../scorers/newsletter-quality-scorer';

// --- Shared schemas ---

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
type ScoredArticle = z.infer<typeof scoredArticleSchema>;

const qualityScoredOutputSchema = z.object({
  markdown: z.string(),
  filePath: z.string(),
  qualityScore: z.number(),
  topic: z.string(),
  refinedTopic: z.string(),
  strengths: z.string(),
  weaknesses: z.string(),
});

// --- Shared helpers ---

function extractArticles(result: any): any[] {
  if (result && 'articles' in result) return result.articles;
  return [];
}

function deduplicateArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    const normalizedUrl = a.url?.replace(/\/$/, '').toLowerCase();
    if (!normalizedUrl || seen.has(normalizedUrl)) return false;
    seen.add(normalizedUrl);
    return true;
  });
}

const organizerOutputSchema = z.object({
  sections: z.array(
    z.object({
      name: z.string(),
      theme: z.string(),
      articleIndices: z.array(z.number()),
    }),
  ),
});

// --- Shared pipeline function (fix #3) ---
// Used by both the main workflow steps and the retry branch.

async function searchAllSources(topic: string): Promise<Article[]> {
  const ctx = {} as any;

  // Fix #2: Each search is wrapped in try/catch for resilience
  const [exaResult1, exaResult2, tavilyResult, bbResult] = await Promise.all([
    exaSearchTool.execute!({ query: `${topic} latest news`, numResults: 10 }, ctx).catch((err) => {
      console.warn(`Exa search (latest) failed: ${err.message}`);
      return { articles: [] };
    }),
    exaSearchTool.execute!({ query: `${topic} breaking`, numResults: 10 }, ctx).catch((err) => {
      console.warn(`Exa search (breaking) failed: ${err.message}`);
      return { articles: [] };
    }),
    tavilySearchTool.execute!({ query: `${topic} news`, maxResults: 10 }, ctx).catch((err) => {
      console.warn(`Tavily search failed: ${err.message}`);
      return { articles: [] };
    }),
    browserbaseTool.execute!({
      urls: [
        `https://news.google.com/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`,
        `https://www.reuters.com/search/news?query=${encodeURIComponent(topic)}`,
        `https://apnews.com/search?q=${encodeURIComponent(topic)}`,
      ],
    }, ctx).catch((err) => {
      console.warn(`Browserbase search failed: ${err.message}`);
      return { articles: [] };
    }),
  ]);

  const allArticles: Article[] = [
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

  return deduplicateArticles(allArticles);
}

async function scoreAndRankArticles(
  articles: Article[],
  topic: string,
): Promise<ScoredArticle[]> {
  const scoredArticles: ScoredArticle[] = [];

  for (let i = 0; i < articles.length; i += 5) {
    const batch = articles.slice(i, i + 5);
    const scores = await scoreArticlesBatch(batch, topic);
    for (let j = 0; j < batch.length; j++) {
      const scoreData = scores[j] || { timeliness: 0.5, novelty: 0.5, urgency: 0.5, score: 0.5 };
      scoredArticles.push({ ...batch[j], ...scoreData });
    }
  }

  scoredArticles.sort((a, b) => b.score - a.score);
  return scoredArticles.slice(0, 20);
}

async function organizeIntoSections(
  scoredArticles: ScoredArticle[],
  topic: string,
  mastra: Mastra,
): Promise<Array<{ name: string; theme: string; articles: ScoredArticle[] }>> {
  const agent = mastra.getAgent('newsOrganizerAgent');
  if (!agent) throw new Error('News organizer agent not found');

  const articleList = scoredArticles
    .map((a, i) => `[${i}] "${a.title}" (score: ${a.score.toFixed(2)}) - ${a.summary.slice(0, 200)}`)
    .join('\n');

  const response = await agent.generate(
    [{
      role: 'user' as const,
      content: `Organize these ${scoredArticles.length} articles about "${topic}" into 3-4 themed sections. Each section needs a descriptive name and a creative, witty subheader.

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
    }],
    { structuredOutput: { schema: organizerOutputSchema } },
  );

  return (response.object?.sections || []).map((section) => ({
    name: section.name,
    theme: section.theme,
    articles: (section.articleIndices || [])
      .filter((idx) => idx < scoredArticles.length)
      .map((idx) => scoredArticles[idx]),
  }));
}

async function writeNewsletterMarkdown(
  sections: Array<{ name: string; theme: string; articles: ScoredArticle[] }>,
  topic: string,
  mastra: Mastra,
  options?: { isRetry?: boolean; previousWeaknesses?: string; previousScore?: number },
): Promise<{ markdown: string; filePath: string }> {
  const agent = mastra.getAgent('newsletterWriterAgent');
  if (!agent) throw new Error('Newsletter writer agent not found');

  const sectionsText = sections
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
  const topicSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const suffix = options?.isRetry ? '-retry' : '';
  const fileName = `${topicSlug}-${today}${suffix}.md`;

  const retryContext = options?.isRetry
    ? `\n\nIMPORTANT: This is a RETRY. The previous version scored ${options.previousScore}/10. Weaknesses: ${options.previousWeaknesses}. Address these issues.`
    : '';

  // Fix #8: Tell the writer how many articles we actually have
  const articleCount = sections.reduce((sum, s) => sum + s.articles.length, 0);

  const response = await agent.generate([{
    role: 'user' as const,
    content: `Write a complete markdown newsletter about "${topic}" for ${today}.

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
- Cover all ${articleCount} articles provided${retryContext}`,
  }]);

  const markdown = response.text || '';

  // Fix #7: Write file directly instead of relying on the agent to call the tool
  const filePath = `./reports/${fileName}`;
  const ctx = {} as any;
  const writeResult = await writeFileTool.execute!({ content: markdown, filePath: fileName }, ctx);
  if (writeResult && 'success' in writeResult && !writeResult.success) {
    console.warn('Failed to write newsletter file');
  }

  return { markdown, filePath };
}

/** Run the full pipeline from search to scored newsletter */
async function runNewsPipeline(
  topic: string,
  mastra: Mastra,
  options?: { isRetry?: boolean; previousWeaknesses?: string; previousScore?: number },
): Promise<{ markdown: string; filePath: string; qualityScore: number }> {
  // 1. Search
  const articles = await searchAllSources(topic);

  // Fix #8: Article count validation
  if (articles.length === 0) {
    throw new Error(`No articles found for topic "${topic}". Try a broader or different topic.`);
  }
  if (articles.length < 5) {
    console.warn(`Only ${articles.length} articles found for "${topic}" — newsletter may be thin.`);
  }
  if (articles.length < 15) {
    console.warn(`Found ${articles.length} articles (fewer than 15 target) for "${topic}".`);
  }

  // 2. Score and rank
  const scoredArticles = await scoreAndRankArticles(articles, topic);

  // 3. Organize
  const sections = await organizeIntoSections(scoredArticles, topic, mastra);

  // 4. Write
  const { markdown, filePath } = await writeNewsletterMarkdown(sections, topic, mastra, options);

  // 5. Quality score
  const evaluation = await scoreNewsletter(markdown, topic);

  return { markdown, filePath, qualityScore: evaluation.overallScore };
}

// --- Workflow steps ---

// Step 1a: Search with Exa (fix #1: passes topic through, fix #2: try/catch)
const exaSearchStep = createStep({
  id: 'exa-search',
  description: 'Search for news articles using Exa',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema), topic: z.string() }),
  execute: async ({ inputData }) => {
    try {
      const ctx = {} as any;
      const [result1, result2] = await Promise.all([
        exaSearchTool.execute!({ query: `${inputData.topic} latest news`, numResults: 10 }, ctx),
        exaSearchTool.execute!({ query: `${inputData.topic} breaking`, numResults: 10 }, ctx),
      ]);

      const allArticles = [...extractArticles(result1), ...extractArticles(result2)];
      const unique = deduplicateArticles(allArticles);

      return { articles: unique, topic: inputData.topic };
    } catch (err: any) {
      console.warn(`Exa search step failed: ${err.message}`);
      return { articles: [], topic: inputData.topic };
    }
  },
});

// Step 1b: Search with Browserbase (fix #1, #2)
const browserbaseSearchStep = createStep({
  id: 'browserbase-search',
  description: 'Browse news sites using Browserbase',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema), topic: z.string() }),
  execute: async ({ inputData }) => {
    try {
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

      return { articles, topic: inputData.topic };
    } catch (err: any) {
      console.warn(`Browserbase search step failed: ${err.message}`);
      return { articles: [], topic: inputData.topic };
    }
  },
});

// Step 1c: Search with Tavily (fix #1, #2)
const tavilySearchStep = createStep({
  id: 'tavily-search',
  description: 'Search for news articles using Tavily',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ articles: z.array(articleSchema), topic: z.string() }),
  execute: async ({ inputData }) => {
    try {
      const ctx = {} as any;
      const result = await tavilySearchTool.execute!(
        { query: `${inputData.topic} news`, maxResults: 10 },
        ctx,
      );

      return { articles: extractArticles(result), topic: inputData.topic };
    } catch (err: any) {
      console.warn(`Tavily search step failed: ${err.message}`);
      return { articles: [], topic: inputData.topic };
    }
  },
});

// Step 2: Merge and deduplicate (fix #1: reads topic from search results, fix #8: validates count)
const mergeResultsStep = createStep({
  id: 'merge-results',
  description: 'Merge and deduplicate articles from all search sources',
  inputSchema: z.object({
    'exa-search': z.object({ articles: z.array(articleSchema), topic: z.string() }),
    'browserbase-search': z.object({ articles: z.array(articleSchema), topic: z.string() }),
    'tavily-search': z.object({ articles: z.array(articleSchema), topic: z.string() }),
  }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    // Fix #1: Read topic from any search result (they all carry it through)
    const topic =
      inputData['exa-search']?.topic ||
      inputData['browserbase-search']?.topic ||
      inputData['tavily-search']?.topic ||
      '';

    const allArticles = [
      ...(inputData['exa-search']?.articles || []),
      ...(inputData['browserbase-search']?.articles || []),
      ...(inputData['tavily-search']?.articles || []),
    ];

    const unique = deduplicateArticles(allArticles);

    // Fix #8: Article count validation
    const exaCount = inputData['exa-search']?.articles?.length || 0;
    const bbCount = inputData['browserbase-search']?.articles?.length || 0;
    const tavilyCount = inputData['tavily-search']?.articles?.length || 0;
    console.log(`Search results — Exa: ${exaCount}, Browserbase: ${bbCount}, Tavily: ${tavilyCount} → ${unique.length} unique articles`);

    if (unique.length === 0) {
      throw new Error(`No articles found for topic "${topic}". All search sources returned empty results. Try a broader or different topic.`);
    }

    if (unique.length < 5) {
      console.warn(`Only ${unique.length} unique articles found for "${topic}" — newsletter quality may be limited.`);
    }

    return { articles: unique, topic };
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
    const scored = await scoreAndRankArticles(inputData.articles, inputData.topic);
    return { scoredArticles: scored, topic: inputData.topic };
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
    if (!mastra) throw new Error('Mastra instance not available');
    const sections = await organizeIntoSections(inputData.scoredArticles, inputData.topic, mastra);
    return { sections, topic: inputData.topic };
  },
});

// Step 5: Write the newsletter (fix #7: writes file directly)
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
    if (!mastra) throw new Error('Mastra instance not available');
    const { markdown, filePath } = await writeNewsletterMarkdown(
      inputData.sections,
      inputData.topic,
      mastra,
    );
    return { markdown, filePath, topic: inputData.topic };
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

    console.log(`\nNewsletter Quality Score: ${evaluation.overallScore}/10`);
    console.log(`  Strengths: ${evaluation.strengths}`);
    console.log(`  Weaknesses: ${evaluation.weaknesses}`);
    if (evaluation.overallScore < 6) {
      console.log(`  Score below 6 — will retry with refined topic: "${evaluation.improvementSuggestion}"`);
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

// Branch A: Newsletter passes quality check (score >= 6)
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
    console.log(`\nNewsletter passed quality check with score ${inputData.qualityScore}/10`);
    return {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: inputData.qualityScore,
    };
  },
});

// Branch B: Newsletter fails quality check (score < 6) — fix #3: uses shared pipeline function
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
    if (!mastra) throw new Error('Mastra instance not available');

    const refinedTopic = inputData.refinedTopic;
    console.log(`\nRetrying pipeline with refined topic: "${refinedTopic}"`);
    console.log(`  Original topic: "${inputData.topic}"`);
    console.log(`  Previous score: ${inputData.qualityScore}/10`);
    console.log(`  Reason: ${inputData.weaknesses}`);

    const result = await runNewsPipeline(refinedTopic, mastra, {
      isRetry: true,
      previousWeaknesses: inputData.weaknesses,
      previousScore: inputData.qualityScore,
    });

    console.log(`\nRetry Newsletter Quality Score: ${result.qualityScore}/10`);

    return result;
  },
});

// --- Workflow assembly ---

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
