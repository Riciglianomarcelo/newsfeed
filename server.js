const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════
// CONFIGURATION — edit your feeds here
// ═══════════════════════════════════════════════════
const FEEDS = [
  { id: "politics",  name: "NY Times Politics",  url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml",                                            emoji: "🏛️", color: "#dc2626", category: "Politics" },
  { id: "latam",     name: "Google News LATAM",   url: "https://news.google.com/rss/search?q=venezuela+OR+latin+america&hl=en-US&gl=US&ceid=US:en",             emoji: "🌍", color: "#16a34a", category: "Latin America" },
  { id: "tech",      name: "TechCrunch",          url: "https://techcrunch.com/feed/",                                                                          emoji: "💻", color: "#2563eb", category: "Tech" },
  { id: "sports",    name: "ESPN",                url: "https://www.espn.com/espn/rss/news",                                                                    emoji: "⚽", color: "#d97706", category: "Sports" },
  { id: "markets",   name: "Bloomberg",           url: "https://feeds.bloomberg.com/markets/news.rss",                                                          emoji: "💰", color: "#7c3aed", category: "Markets" },
];

const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
let cache = { articles: [], status: {}, timestamp: 0 };

// ═══════════════════════════════════════════════════
// RSS PARSING
// ═══════════════════════════════════════════════════
function getTag(block, tag) {
  const cd = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i"));
  if (cd) return cd[1].trim();
  const pl = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return pl ? pl[1].trim() : "";
}

function stripHtml(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").trim();
}

function timeAgoHours(dateStr) {
  if (!dateStr) return 0;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.round(diff / (1000 * 60 * 60)));
}

async function fetchFeed(feed) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { "User-Agent": "DailyBriefing/1.0" },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];

    return items.slice(0, 8).map((block, i) => {
      const title = stripHtml(getTag(block, "title"));
      let link = getTag(block, "link");
      if (!link) {
        const m = block.match(/<link[^>]*href="([^"]+)"/i);
        if (m) link = m[1];
      }
      const desc = stripHtml(getTag(block, "description")).substring(0, 280);
      const pubDate = getTag(block, "pubDate");

      return {
        id: `${feed.id}-${i}`,
        title: title || "Untitled",
        url: link || "#",
        description: desc,
        source: feed.name,
        hoursAgo: timeAgoHours(pubDate),
        pubDate: pubDate || new Date().toISOString(),
        categoryId: feed.id,
        category: feed.category,
        emoji: feed.emoji,
        color: feed.color,
        isLead: i === 0,
      };
    }).filter(a => a.title && a.title !== "Untitled");
  } catch (e) {
    console.error(`[${feed.name}] Failed: ${e.message}`);
    return null;
  }
}

async function fetchAllFeeds() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const articles = [];
  const status = {};

  results.forEach((r, i) => {
    const feedId = FEEDS[i].id;
    if (r.status === "fulfilled" && r.value && r.value.length > 0) {
      articles.push(...r.value);
      status[feedId] = "ok";
    } else {
      status[feedId] = "failed";
    }
  });

  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return { articles, status };
}

// ═══════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/news — returns cached or fresh articles
app.get("/api/news", async (req, res) => {
  const forceRefresh = req.query.refresh === "true";

  if (!forceRefresh && cache.articles.length > 0 && Date.now() - cache.timestamp < CACHE_TTL) {
    return res.json({
      articles: cache.articles,
      status: cache.status,
      cached: true,
      timestamp: cache.timestamp,
      feedCount: FEEDS.length,
    });
  }

  try {
    const { articles, status } = await fetchAllFeeds();
    if (articles.length > 0) {
      cache = { articles, status, timestamp: Date.now() };
    }
    res.json({
      articles: cache.articles,
      status: cache.status,
      cached: false,
      timestamp: cache.timestamp,
      feedCount: FEEDS.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/brief — proxies to Anthropic API for AI analysis
app.post("/api/brief", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });
  }

  const { headlines } = req.body;
  if (!headlines) return res.status(400).json({ error: "No headlines provided" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: `You are a sharp news analyst. Given these headlines from multiple sources:

${headlines}

Do two things:
1. Identify the top 3 most important stories with a "why it matters" sentence.
2. Find stories covered by multiple sources and contrast how their framing differs.

Respond ONLY with valid JSON, no backticks:
{"top_stories":[{"topic":"label","why_it_matters":"sentence","sources":["names"]}],"cross_source":[{"topic":"label","angle_contrast":"how coverage differs"}]}`
        }],
      }),
    });

    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    res.json(match ? JSON.parse(match[0]) : { error: "Could not parse AI response" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/feeds — returns feed configuration
app.get("/api/feeds", (req, res) => {
  res.json(FEEDS.map(f => ({ id: f.id, name: f.name, category: f.category, emoji: f.emoji, color: f.color })));
});

// Fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Daily Briefing running on port ${PORT}`);
  console.log(`AI Brief ${process.env.ANTHROPIC_API_KEY ? "enabled" : "disabled (set ANTHROPIC_API_KEY)"}`);
});
