export type MacroFn = (query?: string) => string;

export const MACROS = {
  '@google_search': (query?: string) => `https://www.google.com/search?q=${encodeURIComponent(query || '')}`,
  '@youtube_search': (query?: string) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`,
  '@amazon_search': (query?: string) => `https://www.amazon.com/s?k=${encodeURIComponent(query || '')}`,
  '@reddit_search': (query?: string) => `https://www.reddit.com/search.json?q=${encodeURIComponent(query || '')}&limit=25`,
  '@reddit_subreddit': (query?: string) => `https://www.reddit.com/r/${encodeURIComponent(query || 'all')}.json?limit=25`,
  '@wikipedia_search': (query?: string) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query || '')}`,
  '@twitter_search': (query?: string) => `https://twitter.com/search?q=${encodeURIComponent(query || '')}`,
  '@yelp_search': (query?: string) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(query || '')}`,
  '@spotify_search': (query?: string) => `https://open.spotify.com/search/${encodeURIComponent(query || '')}`,
  '@netflix_search': (query?: string) => `https://www.netflix.com/search?q=${encodeURIComponent(query || '')}`,
  '@linkedin_search': (query?: string) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query || '')}`,
  '@instagram_search': (query?: string) => `https://www.instagram.com/explore/tags/${encodeURIComponent(query || '')}`,
  '@tiktok_search': (query?: string) => `https://www.tiktok.com/search?q=${encodeURIComponent(query || '')}`,
  '@twitch_search': (query?: string) => `https://www.twitch.tv/search?term=${encodeURIComponent(query || '')}`,
} as const satisfies Record<string, MacroFn>;

export type MacroName = keyof typeof MACROS;

export function expandMacro(macro: string, query?: string): string | null {
  const macroFn = (MACROS as Record<string, MacroFn | undefined>)[macro];
  return macroFn ? macroFn(query) : null;
}

export function getSupportedMacros(): string[] {
  return Object.keys(MACROS);
}
