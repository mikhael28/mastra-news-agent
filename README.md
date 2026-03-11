## Mastra News Agent

A Mastra workflow that researches a topic and produces a scored, publication-ready newsletter in Markdown.

To get started, you will need to:

- Install the dependencies inside of `news-agent` with `npm install`
- Fill out the necessary environment variables, and convert .env.example to .env
- Run `npm run dev` and go to localhost:4111 to open the Studio
- Go to the `Workflows` tab, click 'news-workflow' and in the 'Current Run' subheader on the expanded right sidebar, enter in plaintext the news topic you would like to research and report on.
- Once the newsletter has been generated, you can view the local markdown artifact that is generated at `news-agent/src/mastra/public/reports`

**Workflow steps:**

1. **Parallel search** — queries Exa (×2 queries), Tavily, and Google News / AP News RSS via BrowserBase feeds concurrently
2. **Merge & deduplicate** — combines all results into a single deduplicated article list, stripping tracking parameters from URLs before comparison
3. **Score & rank** — evaluates each article on timeliness, novelty, and urgency; keeps the top 20; scoring batches run in parallel
4. **Organize** — an AI agent groups articles into 3–4 themed sections with creative subheaders
5. **Write** — an AI agent compiles the sections into a full Markdown newsletter and saves it to `src/mastra/public/reports/`
6. **Quality check** — scores the newsletter 1–10 on content depth, writing quality, source variety, and engagement
7. **Branch** — if score ≥ 7 the newsletter is accepted; if score < 7 the pipeline retries with a refined topic, preserving high-scoring articles from the previous pass and supplementing with a fresh targeted search

---

## Quality of life

**RSS instead of browser scraping**
The third search source switched from Browserbase (Puppeteer session, ~15s) to RSS feeds from Google News and AP News (~1–2s). Google News RSS already aggregates Reuters, AP, BBC, and others, so coverage is equivalent with no browser overhead. Also, Browserbase had some issues running locally on my computer, saying there were issues with my 'Profile' on Google Chrome, which is either a) Windows or b) my default Chrome account is a GSuite for business account, and there may be some administrative block I need to resolve. The remote version of browserbase wouldn't stop fetching cached articles from 2024, and wasn't worth the time to debug at the current moment.

**Parallel article scoring**
Article batches are scored concurrently with `Promise.all` rather than one after another. A `p-limit` concurrency cap of 3 simultaneous LLM calls prevents rate-limit errors under load.

**Smart retry — no work thrown away**
When a retry is triggered, previously scored articles are carried forward. Only URLs not seen in the prior pass are scored again. The retry re-organizes the merged pool and re-writes the newsletter with the scorer's weaknesses as explicit context. The best-scoring result across all attempts is always returned.

**`MAX_RETRIES = 2`**
The retry loop runs at most twice before returning the best result seen, preventing runaway LLM costs on a persistently low-scoring topic.

**`QUALITY_THRESHOLD = 7`**
The pass/retry branch condition is a named constant at the top of the workflow file, making it easy to raise or lower the bar without hunting through logic.

**Collision-safe filenames**
Output files include an HHMM time component — e.g. `climate-tech-2026-03-11-1642.md` — so two runs on the same topic in the same day no longer overwrite each other.

--

## Backlog

- Email delivery / Slack delivery at the end, to create a more fully-featured workflow.
- Generate images, based on the newsletter, to include in the markdown file.
- Add a 'Processor' to work with the finished artifact at the end, and scan for a) hallucinations b) child-friendly content c) political sensitivity, from a 'bias' perspective, or something like that to account for either enforcing objectivity or discarding it.
- MCP integration, though at the moment I'm not exactly sure what for.
- Figure out why Browserbase wasn't working
