import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import type { Mastra } from "@mastra/core/mastra";
import pLimit from "p-limit";
import { exaSearchTool } from "../tools/exa-search-tool";
import { rssSearchTool } from "../tools/rss-search-tool";
import { tavilySearchTool } from "../tools/tavily-search-tool";
import { writeFileTool } from "../tools/write-file-tool";
import { scoreArticlesBatch } from "../scorers/news-scorer";
import { scoreNewsletter } from "../scorers/newsletter-quality-scorer";

// --- Constants ---

/** Maximum number of retry attempts when quality score is below threshold. */
const MAX_RETRIES = 2;
/** Max concurrent LLM scorer calls (prevents rate-limit exhaustion). */
const SCORER_CONCURRENCY = 3;
/** Newsletter quality gate — scores below this trigger a retry. */
const QUALITY_THRESHOLD = 7;

const scorerLimit = pLimit(SCORER_CONCURRENCY);

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
  sections: z.array(sectionSchema),
});

// --- Shared helpers ---

function extractArticles(result: any): any[] {
  if (result && "articles" in result) return result.articles;
  return [];
}

function deduplicateArticles(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    // Strip query params and trailing slashes to catch tracking-param dupes
    let key = a.url;
    try {
      const u = new URL(a.url);
      u.search = "";
      key = u.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      key = a.url.replace(/\/$/, "").toLowerCase();
    }
    if (!key || seen.has(key)) return false;
    seen.add(key);
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

// --- Shared pipeline helpers ---

async function searchAllSources(topic: string): Promise<Article[]> {
  const ctx = {} as any;

  const [exaResult1, exaResult2, tavilyResult, rssResult] = await Promise.all([
    exaSearchTool
      .execute!({ query: `${topic} latest news`, numResults: 10 }, ctx)
      .catch((err) => {
        console.warn(`Exa search (latest) failed: ${err.message}`);
        return { articles: [] };
      }),
    exaSearchTool
      .execute!({ query: `${topic} breaking`, numResults: 10 }, ctx)
      .catch((err) => {
        console.warn(`Exa search (breaking) failed: ${err.message}`);
        return { articles: [] };
      }),
    tavilySearchTool
      .execute!({ query: `${topic} news`, maxResults: 10 }, ctx)
      .catch((err) => {
        console.warn(`Tavily search failed: ${err.message}`);
        return { articles: [] };
      }),
    rssSearchTool
      .execute!({ topic, maxResults: 20 }, ctx)
      .catch((err) => {
        console.warn(`RSS search failed: ${err.message}`);
        return { articles: [] };
      }),
  ]);

  const allArticles: Article[] = [
    ...extractArticles(exaResult1),
    ...extractArticles(exaResult2),
    ...extractArticles(tavilyResult),
    ...extractArticles(rssResult),
  ];

  return deduplicateArticles(allArticles);
}

/**
 * Score and rank articles in parallel batches of 5, capped at SCORER_CONCURRENCY
 * concurrent LLM calls to avoid rate-limit errors.
 */
async function scoreAndRankArticles(
  articles: Article[],
  topic: string,
): Promise<ScoredArticle[]> {
  const batches: Article[][] = [];
  for (let i = 0; i < articles.length; i += 5) {
    batches.push(articles.slice(i, i + 5));
  }

  const batchResults = await Promise.all(
    batches.map((batch) =>
      scorerLimit(() => scoreArticlesBatch(batch, topic)),
    ),
  );

  const scoredArticles: ScoredArticle[] = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const scores = batchResults[b] ?? [];
    for (let j = 0; j < batch.length; j++) {
      const scoreData = scores[j] ?? {
        timeliness: 0.5,
        novelty: 0.5,
        urgency: 0.5,
        score: 0.5,
      };
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
  const agent = mastra.getAgent("newsOrganizerAgent");
  if (!agent) throw new Error("News organizer agent not found");

  const articleList = scoredArticles
    .map(
      (a, i) =>
        `[${i}] "${a.title}" (score: ${a.score.toFixed(2)}) - ${a.summary.slice(0, 200)}`,
    )
    .join("\n");

  const response = await agent.generate(
    [
      {
        role: "user" as const,
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
      },
    ],
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
  options?: {
    isRetry?: boolean;
    previousWeaknesses?: string;
    previousScore?: number;
  },
): Promise<{ markdown: string; filePath: string }> {
  const agent = mastra.getAgent("newsletterWriterAgent");
  if (!agent) throw new Error("Newsletter writer agent not found");

  const sectionsText = sections
    .map((s) => {
      const articleDetails = s.articles
        .map(
          (a) =>
            `- "${a.title}" | URL: ${a.url} | Source: ${a.source || "unknown"} | Score: ${a.score.toFixed(2)}\n  Summary: ${a.summary.slice(0, 300)}`,
        )
        .join("\n");
      return `## ${s.name}\n*${s.theme}*\n\n${articleDetails}`;
    })
    .join("\n\n");

  const now = new Date();
  const today = now.toISOString().split("T")[0];
  // HHMM suffix prevents same-day filename collisions
  const timeStamp = now.toISOString().split("T")[1].slice(0, 5).replace(":", "");
  const topicSlug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const retrySuffix = options?.isRetry ? "-retry" : "";
  const fileName = `${topicSlug}-${today}-${timeStamp}${retrySuffix}.md`;

  const retryContext = options?.isRetry
    ? `\n\nIMPORTANT: This is a RETRY. The previous version scored ${options.previousScore}/10. Weaknesses: ${options.previousWeaknesses}. Address these issues directly.`
    : "";

  const articleCount = sections.reduce((sum, s) => sum + s.articles.length, 0);

  const response = await agent.generate([
    {
      role: "user" as const,
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
    },
  ]);

  const markdown = response.text || "";

  const ctx = {} as any;
  const writeResult = await writeFileTool.execute!(
    { content: markdown, filePath: fileName },
    ctx,
  );
  if (writeResult && "success" in writeResult && !writeResult.success) {
    console.warn("Failed to write newsletter file");
  }

  return { markdown, filePath: `./reports/${fileName}` };
}

// --- Workflow steps ---

// Step 1a: Search with Exa
const exaSearchStep = createStep({
  id: "exa-search",
  description: "Search for news articles using Exa",
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    try {
      const ctx = {} as any;
      const [result1, result2] = await Promise.all([
        exaSearchTool.execute!(
          { query: `${inputData.topic} latest news`, numResults: 10 },
          ctx,
        ),
        exaSearchTool.execute!(
          { query: `${inputData.topic} breaking`, numResults: 10 },
          ctx,
        ),
      ]);

      const allArticles = [
        ...extractArticles(result1),
        ...extractArticles(result2),
      ];
      const unique = deduplicateArticles(allArticles);

      return { articles: unique, topic: inputData.topic };
    } catch (err: any) {
      console.warn(`Exa search step failed: ${err.message}`);
      return { articles: [], topic: inputData.topic };
    }
  },
});

// Step 1b: Search via RSS feeds (Google News + AP News)
const rssSearchStep = createStep({
  id: "rss-search",
  description:
    "Fetch news articles from Google News and AP News RSS feeds — fast, structured, no browser needed",
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    try {
      const ctx = {} as any;
      const result = await rssSearchTool.execute!(
        { topic: inputData.topic, maxResults: 20 },
        ctx,
      );
      return { articles: extractArticles(result), topic: inputData.topic };
    } catch (err: any) {
      console.warn(`RSS search step failed: ${err.message}`);
      return { articles: [], topic: inputData.topic };
    }
  },
});

// Step 1c: Search with Tavily
const tavilySearchStep = createStep({
  id: "tavily-search",
  description: "Search for news articles using Tavily",
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
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

// Step 2: Merge and deduplicate
const mergeResultsStep = createStep({
  id: "merge-results",
  description: "Merge and deduplicate articles from all search sources",
  inputSchema: z.object({
    "exa-search": z.object({
      articles: z.array(articleSchema),
      topic: z.string(),
    }),
    "rss-search": z.object({
      articles: z.array(articleSchema),
      topic: z.string(),
    }),
    "tavily-search": z.object({
      articles: z.array(articleSchema),
      topic: z.string(),
    }),
  }),
  outputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    const topic =
      inputData["exa-search"]?.topic ||
      inputData["rss-search"]?.topic ||
      inputData["tavily-search"]?.topic ||
      "";

    const allArticles = [
      ...(inputData["exa-search"]?.articles || []),
      ...(inputData["rss-search"]?.articles || []),
      ...(inputData["tavily-search"]?.articles || []),
    ];

    const unique = deduplicateArticles(allArticles);

    const exaCount = inputData["exa-search"]?.articles?.length ?? 0;
    const rssCount = inputData["rss-search"]?.articles?.length ?? 0;
    const tavilyCount = inputData["tavily-search"]?.articles?.length ?? 0;
    console.log(
      `Search results — Exa: ${exaCount}, RSS: ${rssCount}, Tavily: ${tavilyCount} → ${unique.length} unique articles`,
    );

    if (unique.length === 0) {
      throw new Error(
        `No articles found for topic "${topic}". All search sources returned empty results. Try a broader or different topic.`,
      );
    }

    if (unique.length < 5) {
      console.warn(
        `Only ${unique.length} unique articles found for "${topic}" — newsletter quality may be limited.`,
      );
    }

    return { articles: unique, topic };
  },
});

// Step 3: Score articles (parallel batches, concurrency-limited)
const scoreArticlesStep = createStep({
  id: "score-articles",
  description:
    "Score articles on timeliness, novelty, and urgency — batches run in parallel",
  inputSchema: z.object({
    articles: z.array(articleSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    scoredArticles: z.array(scoredArticleSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData }) => {
    const scored = await scoreAndRankArticles(
      inputData.articles,
      inputData.topic,
    );
    return { scoredArticles: scored, topic: inputData.topic };
  },
});

// Step 4: Organize into themed sections
const organizeStoriesStep = createStep({
  id: "organize-stories",
  description:
    "Organize scored articles into themed sections with creative subheaders",
  inputSchema: z.object({
    scoredArticles: z.array(scoredArticleSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    sections: z.array(sectionSchema),
    topic: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!mastra) throw new Error("Mastra instance not available");
    const sections = await organizeIntoSections(
      inputData.scoredArticles,
      inputData.topic,
      mastra,
    );
    return { sections, topic: inputData.topic };
  },
});

// Step 5: Write the newsletter
const writeNewsletterStep = createStep({
  id: "write-newsletter",
  description: "Compile the final markdown newsletter and write to file",
  inputSchema: z.object({
    sections: z.array(sectionSchema),
    topic: z.string(),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    topic: z.string(),
    sections: z.array(sectionSchema),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!mastra) throw new Error("Mastra instance not available");
    const { markdown, filePath } = await writeNewsletterMarkdown(
      inputData.sections,
      inputData.topic,
      mastra,
    );
    return {
      markdown,
      filePath,
      topic: inputData.topic,
      sections: inputData.sections,
    };
  },
});

// Step 6: Score the newsletter quality (1-10 expert review)
const scoreNewsletterStep = createStep({
  id: "score-newsletter",
  description:
    "Score the newsletter quality on a 1-10 scale from a subject matter expert perspective",
  inputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    topic: z.string(),
    sections: z.array(sectionSchema),
  }),
  outputSchema: qualityScoredOutputSchema,
  execute: async ({ inputData }) => {
    const evaluation = await scoreNewsletter(
      inputData.markdown,
      inputData.topic,
    );

    console.log(`\nNewsletter Quality Score: ${evaluation.overallScore}/10`);
    console.log(`  Strengths: ${evaluation.strengths}`);
    console.log(`  Weaknesses: ${evaluation.weaknesses}`);
    if (evaluation.overallScore < QUALITY_THRESHOLD) {
      console.log(
        `  Score below ${QUALITY_THRESHOLD} — will retry with refined topic: "${evaluation.improvementSuggestion}"`,
      );
    }

    const rawRefinedTopic =
      evaluation.improvementSuggestion || inputData.topic;
    const refinedTopic = rawRefinedTopic.slice(0, 80);

    return {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: evaluation.overallScore,
      topic: inputData.topic,
      refinedTopic,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      sections: inputData.sections,
    };
  },
});

// Branch A: Newsletter passes quality check
const passQualityStep = createStep({
  id: "pass-quality",
  description: "Newsletter passed quality check, return final result",
  inputSchema: qualityScoredOutputSchema,
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
  execute: async ({ inputData }) => {
    console.log(
      `\nNewsletter passed quality check with score ${inputData.qualityScore}/10`,
    );
    return {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: inputData.qualityScore,
    };
  },
});

/**
 * Branch B: Newsletter failed quality check.
 *
 * Smart retry strategy — rather than discarding everything and starting over:
 * 1. Keep all scored articles from the previous pass as a baseline.
 * 2. Do a fresh targeted search with the refined topic to supplement weak areas.
 * 3. Merge old and new articles, re-score only the new ones (reuse existing scores).
 * 4. Re-organize and re-write with explicit guidance on the identified weaknesses.
 * 5. Repeat up to MAX_RETRIES times, always keeping the best result seen so far.
 */
const retryPipelineStep = createStep({
  id: "retry-pipeline",
  description:
    "Re-run the pipeline with a refined topic, preserving good prior content",
  inputSchema: qualityScoredOutputSchema,
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!mastra) throw new Error("Mastra instance not available");

    // Track the best result across all retry attempts
    let best = {
      markdown: inputData.markdown,
      filePath: inputData.filePath,
      qualityScore: inputData.qualityScore,
    };

    // Carry forward the scored articles from the first pass
    let previousScoredArticles: ScoredArticle[] = inputData.sections.flatMap(
      (s) => s.articles,
    );
    let currentTopic = inputData.refinedTopic;
    let currentWeaknesses = inputData.weaknesses;
    let currentScore = inputData.qualityScore;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(
        `\nRetry ${attempt}/${MAX_RETRIES} — topic: "${currentTopic}"`,
      );
      console.log(`  Previous score: ${currentScore}/10`);
      console.log(`  Weaknesses: ${currentWeaknesses}`);

      // 1. Fresh targeted search
      const newArticles = await searchAllSources(currentTopic);

      // 2. Score only the truly new articles (preserve existing scores)
      const existingUrls = new Set(
        previousScoredArticles.map((a) => {
          try {
            const u = new URL(a.url);
            u.search = "";
            return u.toString().replace(/\/$/, "").toLowerCase();
          } catch {
            return a.url.replace(/\/$/, "").toLowerCase();
          }
        }),
      );
      const trulyNew = newArticles.filter((a) => {
        let key = a.url;
        try {
          const u = new URL(a.url);
          u.search = "";
          key = u.toString().replace(/\/$/, "").toLowerCase();
        } catch {
          key = a.url.replace(/\/$/, "").toLowerCase();
        }
        return !existingUrls.has(key);
      });

      console.log(
        `  Found ${newArticles.length} articles (${trulyNew.length} new)`,
      );

      const newScored =
        trulyNew.length > 0
          ? await scoreAndRankArticles(trulyNew, currentTopic)
          : [];

      // 3. Merge old + new, pick the top 20
      const combined = [...previousScoredArticles, ...newScored];
      combined.sort((a, b) => b.score - a.score);
      const top20 = combined.slice(0, 20);

      // 4. Re-organize with the merged pool
      const sections = await organizeIntoSections(top20, currentTopic, mastra);

      // 5. Rewrite with explicit weaknesses context
      const { markdown, filePath } = await writeNewsletterMarkdown(
        sections,
        currentTopic,
        mastra,
        {
          isRetry: true,
          previousWeaknesses: currentWeaknesses,
          previousScore: currentScore,
        },
      );

      // 6. Quality check
      const evaluation = await scoreNewsletter(markdown, currentTopic);
      console.log(
        `  Retry ${attempt} score: ${evaluation.overallScore}/10`,
      );

      // Keep the best result seen so far
      if (evaluation.overallScore > best.qualityScore) {
        best = { markdown, filePath, qualityScore: evaluation.overallScore };
        previousScoredArticles = sections.flatMap((s) => s.articles);
      }

      if (evaluation.overallScore >= QUALITY_THRESHOLD) {
        console.log(`  Quality threshold met — stopping retries.`);
        break;
      }

      // Prepare next iteration
      const rawRefined = evaluation.improvementSuggestion || currentTopic;
      currentTopic = rawRefined.slice(0, 80);
      currentWeaknesses = evaluation.weaknesses;
      currentScore = evaluation.overallScore;
    }

    return best;
  },
});

// --- Workflow assembly ---

const newsWorkflow = createWorkflow({
  id: "news-workflow",
  inputSchema: z.object({
    topic: z.string().describe("The news topic to research and report on"),
  }),
  outputSchema: z.object({
    markdown: z.string(),
    filePath: z.string(),
    qualityScore: z.number(),
  }),
})
  .parallel([exaSearchStep, rssSearchStep, tavilySearchStep])
  .then(mergeResultsStep)
  .then(scoreArticlesStep)
  .then(organizeStoriesStep)
  .then(writeNewsletterStep)
  .then(scoreNewsletterStep)
  .branch([
    [
      async ({ inputData }) =>
        (inputData as any).qualityScore >= QUALITY_THRESHOLD,
      passQualityStep,
    ],
    [
      async ({ inputData }) =>
        (inputData as any).qualityScore < QUALITY_THRESHOLD,
      retryPipelineStep,
    ],
  ]);

newsWorkflow.commit();

export { newsWorkflow };
