import type { Tool } from "./types";

export const web_search: Tool = {
  schema: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for a query and return relevant search result titles, URLs, and brief snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search terms or query." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  async run({ query }, signal) {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new Error("web_search: 'query' must be a non-empty string");
    }

    try {
      const encodedQuery = encodeURIComponent(query.trim());
      const timeoutSignal = AbortSignal.timeout(8000);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      // Jina search may require an API key.
      const headers: Record<string, string> = { Accept: "text/plain" };
      const jinaKey = process.env.JINA_API_KEY?.trim();
      if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;

      const response = await fetch(`https://s.jina.ai/${encodedQuery}`, {
        headers,
        signal: combinedSignal,
      });

      if (response.status === 401) {
        throw new Error(
          "web_search: 401 Unauthorized — s.jina.ai needs a free API key. Get one at https://jina.ai/api-dashboard/ and set JINA_API_KEY in your .env",
        );
      }
      if (!response.ok) {
        throw new Error(`web_search: HTTP error! status: ${response.status} ${response.statusText}`);
      }

      const results = await response.text();
      if (!results || results.trim().length === 0) {
        return "No search results found.";
      }

      return results;
    } catch (error: any) {
      if (signal?.aborted) {
        throw new Error("web_search: search interrupted by user");
      }
      throw new Error(`web_search: Failed to retrieve search results: ${error.message}`);
    }
  },
};
