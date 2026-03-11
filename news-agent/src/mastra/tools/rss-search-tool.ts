import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// --- Minimal RSS/Atom XML parser (no external dependency) ---

function extractTag(xml: string, tag: string): string {
  const cdataMatch = xml.match(
    new RegExp(
      `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
      "i",
    ),
  );
  if (cdataMatch) return cdataMatch[1].trim();
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i"),
  );
  return match ? match[1] : "";
}

function stripHtml(str: string): string {
  return str
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface RssArticle {
  title: string;
  url: string;
  publishedDate: string;
  summary: string;
  source: string;
}

function parseRssXml(xml: string): RssArticle[] {
  const articles: RssArticle[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = extractTag(item, "title");
    const link =
      extractTag(item, "link") || extractAttr(item, "guid", "isPermaLink");
    const pubDate = extractTag(item, "pubDate");
    const description = extractTag(item, "description");
    const source = extractTag(item, "source");

    if (!title || !link || !link.startsWith("http")) continue;

    let hostname = "";
    try {
      hostname = new URL(link).hostname;
    } catch {
      continue;
    }

    articles.push({
      title,
      url: link,
      publishedDate: pubDate ? new Date(pubDate).toISOString() : "",
      summary: stripHtml(description).slice(0, 500),
      source: source || hostname,
    });
  }

  return articles;
}

// --- Three feed URLs per topic: Google News search + Reuters + AP ---

function buildFeedUrls(topic: string): string[] {
  const q = encodeURIComponent(topic);
  return [
    // Google News aggregates Reuters, AP, BBC, etc. — most reliable source
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    // AP News RSS (general top news, not topic-filtered but highly authoritative)
    `https://apnews.com/apf-topnews`,
  ];
}

export const rssSearchTool = createTool({
  id: "rss-search",
  description:
    "Fetch recent news articles from Google News and AP News RSS feeds for a given topic",
  inputSchema: z.object({
    topic: z.string().describe("The news topic to search for"),
    maxResults: z
      .number()
      .default(20)
      .describe("Maximum number of articles to return"),
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
    const feedUrls = buildFeedUrls(inputData.topic);
    const articles: RssArticle[] = [];

    await Promise.all(
      feedUrls.map(async (url) => {
        try {
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0; +RSS)",
              Accept: "application/rss+xml, application/xml, text/xml",
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) return;
          const xml = await response.text();
          const parsed = parseRssXml(xml);
          articles.push(...parsed);
        } catch {
          // silently skip unreachable feeds
        }
      }),
    );

    // Deduplicate by URL before returning
    const seen = new Set<string>();
    const unique = articles.filter((a) => {
      const key = a.url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { articles: unique.slice(0, inputData.maxResults) };
  },
});
