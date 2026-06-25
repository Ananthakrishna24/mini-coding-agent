import type { Tool } from "./types";

const MAX_CHARS = 50_000;
const JINA_TIMEOUT_MS = 25_000;
// browser UA: default undici UA gets 403'd by Cloudflare and many sites
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function cap(text: string): string {
  return text.length > MAX_CHARS
    ? text.slice(0, MAX_CHARS) + "\n\n[truncated: content exceeded 50000 chars]"
    : text;
}

export const web_fetch: Tool = {
  schema: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch the content of a URL and return it as clean, readable text. Supports HTTP and HTTPS. " +
        "Strips HTML tags, scripts, and styling to keep context usage low.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The HTTP/HTTPS URL to fetch content from." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  async run({ url }, signal) {
    if (typeof url !== "string") {
      throw new Error("web_fetch: 'url' must be a string");
    }

    try {
      new URL(url);
    } catch {
      throw new Error(`web_fetch: Invalid URL "${url}"`);
    }

    // 1. If it's a localhost/intranet URL, parse locally.
    if (isLocalUrl(url)) {
      return fetchLocally(url, signal);
    }

    // 2. Otherwise, try fetching via Jina Reader (free markdown conversion service)
    try {
      const timeoutSignal = AbortSignal.timeout(JINA_TIMEOUT_MS);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const jinaResponse = await fetch(`https://r.jina.ai/${url}`, {
        headers: {
          Accept: "text/markdown",
        },
        signal: combinedSignal,
      });

      if (jinaResponse.ok) {
        const text = await jinaResponse.text();
        if (text && text.trim().length > 0) {
          return cap(text);
        }
      }
    } catch (error: any) {
      // If the user actively interrupted the request, abort.
      if (signal?.aborted) {
        throw new Error("web_fetch: request interrupted by user");
      }
      // Otherwise (timeout or network error), fall back to local parser.
    }

    // 3. Fallback: Fetch and parse locally if Jina is unavailable/fails
    return fetchLocally(url, signal);
  },
};

function isLocalUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localhost")
    ) {
      return true;
    }
    // Check if it's a private IP address (10.x.x.x, 192.168.x.x, 172.16.x.x - 172.31.x.x)
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)) {
      return true;
    }
    return false;
  } catch {
    return true; // safe default fallback
  }
}

async function fetchLocally(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, headers: { "User-Agent": UA } });
  if (!response.ok) {
    throw new Error(`web_fetch: HTTP error! status: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("text/html")) {
    return cap(cleanHtml(text));
  }

  return cap(text);
}

function cleanHtml(html: string): string {
  // Remove script, style tags, and comments completely
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Replace common block elements with newlines to preserve structure
  text = text
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<\/li>/gi, "\n");

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode basic HTML entities
  text = text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    // numeric entities: &#8217; (decimal) and &#x2019; (hex) — smart quotes, dashes, etc.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));

  // Collapse consecutive spaces and newlines
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return text;
}
