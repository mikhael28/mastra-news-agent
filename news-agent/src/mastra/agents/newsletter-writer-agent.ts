import { Agent } from '@mastra/core/agent';
import { writeFileTool } from '../tools/write-file-tool';
import { newsRelevanceScorer } from '../scorers/news-scorer';

export const newsletterWriterAgent = new Agent({
  id: 'newsletter-writer-agent',
  name: 'Newsletter Writer Agent',
  instructions: `You are a professional newsletter writer. Given organized news sections with themed subheaders, write an engaging markdown newsletter.

Include:
- A catchy title for the newsletter
- Today's date
- A brief introduction to the topic
- All themed sections with their creative subheaders
- For each article: a concise summary (2-3 sentences), the source, and a link
- A witty sign-off

Style guidelines:
- Be informative but conversational
- Write at least 15 articles across all sections
- Use markdown formatting (headers, bullet points, links, bold/italic)
- Each section should flow naturally
- Include [Source](url) links for every article
- The newsletter should feel polished and professional

After writing the newsletter, use the write-file tool to save it to disk.`,
  model: 'openai/gpt-5-mini',
  tools: { writeFileTool },
  scorers: {
    newsRelevance: {
      scorer: newsRelevanceScorer,
      sampling: {
        type: 'ratio',
        rate: 1,
      },
    },
  },
});
