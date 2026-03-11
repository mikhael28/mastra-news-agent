
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { weatherAgent } from './agents/weather-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { newsWorkflow } from './workflows/news-workflow';
import { newsResearcherAgent } from './agents/news-researcher-agent';
import { newsOrganizerAgent } from './agents/news-organizer-agent';
import { newsletterWriterAgent } from './agents/newsletter-writer-agent';
import { newsRelevanceScorer } from './scorers/news-scorer';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, newsWorkflow },
  agents: { weatherAgent, newsResearcherAgent, newsOrganizerAgent, newsletterWriterAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer, newsRelevanceScorer },
  storage: new LibSQLStore({
    id: "mastra-storage",
    // stores observability, scores, ... into persistent file storage
    url: "file:./mastra.db",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends traces to Mastra Cloud (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
