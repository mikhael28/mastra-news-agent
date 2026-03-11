import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import Browserbase from '@browserbasehq/sdk';
import puppeteer from 'puppeteer-core';

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

export const browserbaseTool = createTool({
  id: 'browserbase-browse',
  description: 'Browse news websites using Browserbase to extract article information',
  inputSchema: z.object({
    urls: z.array(z.string()).describe('URLs to visit and extract content from'),
  }),
  outputSchema: z.object({
    articles: z.array(
      z.object({
        url: z.string(),
        title: z.string(),
        content: z.string(),
        scrapedAt: z.string(),
      }),
    ),
  }),
  execute: async (inputData) => {
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });

    const browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
    });

    const articles: Array<{
      url: string;
      title: string;
      content: string;
      scrapedAt: string;
    }> = [];

    try {
      const page = await browser.newPage();

      for (const url of inputData.urls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

          const result = await page.evaluate(() => {
            const title = document.title || '';
            const articleEl =
              document.querySelector('article') ||
              document.querySelector('[role="main"]') ||
              document.querySelector('main') ||
              document.body;
            const content = articleEl?.innerText?.slice(0, 2000) || '';
            return { title, content };
          });

          articles.push({
            url,
            title: result.title,
            content: result.content,
            scrapedAt: new Date().toISOString(),
          });
        } catch {
          // Skip URLs that fail to load
        }
      }
    } finally {
      await browser.close();
    }

    return { articles };
  },
});
