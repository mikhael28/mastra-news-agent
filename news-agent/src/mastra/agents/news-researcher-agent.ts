import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { exaSearchTool } from '../tools/exa-search-tool';
import { browserbaseTool } from '../tools/browserbase-tool';
import { tavilySearchTool } from '../tools/tavily-search-tool';

export const newsResearcherAgent = new Agent({
  id: 'news-researcher-agent',
  name: 'News Researcher Agent',
  instructions: `You are a news researcher. Given a topic, use the available search tools to find at least 15 recent, relevant news articles. Use multiple search queries with varied phrasing to maximize coverage.

For each search:
- Try different angles and phrasings of the topic
- Use at least 2 different search tools
- Focus on articles from the last 24-48 hours
- Prioritize reputable news sources
- Avoid duplicate articles

Return all found articles with their titles, URLs, publication dates, and summaries.`,
  model: 'openai/gpt-5-mini',
  tools: { exaSearchTool, browserbaseTool, tavilySearchTool },
  memory: new Memory(),
});
