import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tavily } from '@tavily/core';

const client = tavily({ apiKey: process.env.TAVILY_API_KEY });

export const tavilySearchTool = createTool({
  id: 'tavily-search',
  description: 'Search for recent news articles using Tavily search API',
  inputSchema: z.object({
    query: z.string().describe('Search query for finding news articles'),
    maxResults: z.number().default(10).describe('Maximum number of results'),
  }),
  outputSchema: z.object({
    articles: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        publishedDate: z.string().optional(),
        summary: z.string(),
        source: z.string().optional(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const response = await client.search(inputData.query, {
      searchDepth: 'advanced',
      topic: 'news',
      maxResults: inputData.maxResults,
      includeAnswer: false,
      includeRawContent: false,
    });

    const articles = response.results.map((r) => ({
      title: r.title,
      url: r.url,
      publishedDate: r.publishedDate || undefined,
      summary: r.content,
      source: new URL(r.url).hostname,
    }));

    return { articles };
  },
});
