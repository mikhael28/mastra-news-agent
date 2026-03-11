import { Agent } from '@mastra/core/agent';

export const newsOrganizerAgent = new Agent({
  id: 'news-organizer-agent',
  name: 'News Organizer Agent',
  instructions: `You organize news articles into 3-4 thematic sections. Each section gets a creative, witty, and funny subheader that captures the theme (e.g., "Quarterbacks on the Move" for QB trades, "Defense Wins Championships" for defensive player news).

Rules:
- Every article must appear in exactly one section
- Group by narrative themes, not just categories
- Each section should have a descriptive name and a creative subheader
- Sections should feel like chapters in a story, not just buckets
- Aim for roughly even distribution of articles across sections
- The subheaders should be clever and engaging, making the reader want to read more`,
  model: 'openai/gpt-5-mini',
  tools: {},
});
