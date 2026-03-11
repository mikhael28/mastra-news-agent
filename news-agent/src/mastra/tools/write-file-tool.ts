import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

export const writeFileTool = createTool({
  id: 'write-file',
  description: 'Write content to a file on disk',
  inputSchema: z.object({
    content: z.string().describe('The content to write to the file'),
    filePath: z.string().describe('The file path relative to the reports directory'),
  }),
  outputSchema: z.object({
    filePath: z.string(),
    success: z.boolean(),
  }),
  execute: async (inputData) => {
    const reportsDir = path.resolve('./reports');
    const fullPath = path.join(reportsDir, inputData.filePath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, inputData.content, 'utf-8');

    return { filePath: fullPath, success: true };
  },
});
