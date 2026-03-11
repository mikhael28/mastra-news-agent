import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { exaSearchTool } from '../tools/exa-search-tool';
import { browserbaseTool } from '../tools/browserbase-tool';
import { tavilySearchTool } from '../tools/tavily-search-tool';
import { scoreArticlesBatch } from '../scorers/news-scorer';

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

    // Topic is passed through from the workflow input via the parallel steps.
    // We extract it from the step context - since parallel steps share the same trigger input,
    // we'll set it as empty here and rely on the workflow engine to provide it.
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

    return { markdown, filePath: `./reports/${fileName}` };
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
  }),
})
  .parallel([exaSearchStep, browserbaseSearchStep, tavilySearchStep])
  .then(mergeResultsStep)
  .then(scoreArticlesStep)
  .then(organizeStoriesStep)
  .then(writeNewsletterStep);

newsWorkflow.commit();

export { newsWorkflow };
