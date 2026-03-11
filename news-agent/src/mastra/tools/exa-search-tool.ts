import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import Exa from 'exa-js';

const exa = new Exa(process.env.EXA_API_KEY);

export const exaSearchTool = createTool({
  id: 'exa-search',
  description: 'Search for recent news articles using Exa neural search',
  inputSchema: z.object({
    query: z.string().describe('Search query for finding news articles'),
    numResults: z.number().default(10).describe('Number of results to return'),
  }),
  outputSchema: z.object({
    articles: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        publishedDate: z.string().optional(),
        summary: z.string(),
        source: z.string().optional(),
        author: z.string().optional(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const results = await exa.search(inputData.query, {
      type: 'neural',
      numResults: inputData.numResults,
      contents: {
        text: { maxCharacters: 1000 },
        summary: true,
      },
    });

    const articles = results.results.map((r) => ({
      title: r.title || 'Untitled',
      url: r.url,
      publishedDate: r.publishedDate,
      summary: r.summary || r.text || '',
      source: new URL(r.url).hostname,
      author: r.author,
    }));

    return { articles };
  },
});
