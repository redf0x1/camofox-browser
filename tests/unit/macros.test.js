const { expandMacro, getSupportedMacros, MACROS } = require('../../dist/src/utils/macros');

describe('Macro URL Expansion (unit)', () => {
  
  test('all macros are defined', () => {
    const macros = getSupportedMacros();
    expect(macros).toContain('@google_search');
    expect(macros).toContain('@youtube_search');
    expect(macros).toContain('@amazon_search');
    expect(macros).toContain('@reddit_search');
    expect(macros).toContain('@wikipedia_search');
    expect(macros).toContain('@twitter_search');
    expect(macros).toContain('@yelp_search');
    expect(macros).toContain('@spotify_search');
    expect(macros).toContain('@netflix_search');
    expect(macros).toContain('@linkedin_search');
    expect(macros).toContain('@instagram_search');
    expect(macros).toContain('@tiktok_search');
    expect(macros).toContain('@twitch_search');
    expect(macros).toContain('@reddit_subreddit');
    expect(macros.length).toBe(14);
  });

  test('@google_search expands correctly', () => {
    expect(expandMacro('@google_search', 'test query'))
      .toBe('https://www.google.com/search?q=test%20query');
  });

  test('@youtube_search expands correctly', () => {
    expect(expandMacro('@youtube_search', 'funny cats'))
      .toBe('https://www.youtube.com/results?search_query=funny%20cats');
  });

  test('@amazon_search expands correctly', () => {
    expect(expandMacro('@amazon_search', 'laptop stand'))
      .toBe('https://www.amazon.com/s?k=laptop%20stand');
  });

  test('@reddit_search expands correctly', () => {
    expect(expandMacro('@reddit_search', 'programming'))
      .toBe('https://www.reddit.com/search.json?q=programming&limit=25');
  });

  test('@reddit_subreddit expands correctly', () => {
    expect(expandMacro('@reddit_subreddit', 'programming'))
      .toBe('https://www.reddit.com/r/programming.json?limit=25');
  });

  test('@wikipedia_search expands correctly', () => {
    expect(expandMacro('@wikipedia_search', 'JavaScript'))
      .toBe('https://en.wikipedia.org/wiki/Special:Search?search=JavaScript');
  });

  test('@twitter_search expands correctly', () => {
    expect(expandMacro('@twitter_search', 'breaking news'))
      .toBe('https://twitter.com/search?q=breaking%20news');
  });

  test('@yelp_search expands correctly', () => {
    expect(expandMacro('@yelp_search', 'italian restaurant'))
      .toBe('https://www.yelp.com/search?find_desc=italian%20restaurant');
  });

  test('@spotify_search expands correctly', () => {
    expect(expandMacro('@spotify_search', 'jazz music'))
      .toBe('https://open.spotify.com/search/jazz%20music');
  });

  test('@netflix_search expands correctly', () => {
    expect(expandMacro('@netflix_search', 'comedy'))
      .toBe('https://www.netflix.com/search?q=comedy');
  });

  test('@linkedin_search expands correctly', () => {
    expect(expandMacro('@linkedin_search', 'software engineer'))
      .toBe('https://www.linkedin.com/search/results/all/?keywords=software%20engineer');
  });

  test('@instagram_search expands correctly', () => {
    expect(expandMacro('@instagram_search', 'travel'))
      .toBe('https://www.instagram.com/explore/tags/travel');
  });

  test('@tiktok_search expands correctly', () => {
    expect(expandMacro('@tiktok_search', 'dance'))
      .toBe('https://www.tiktok.com/search?q=dance');
  });

  test('@twitch_search expands correctly', () => {
    expect(expandMacro('@twitch_search', 'gaming'))
      .toBe('https://www.twitch.tv/search?term=gaming');
  });

  test('special characters are URL encoded', () => {
    expect(expandMacro('@google_search', 'hello & world'))
      .toBe('https://www.google.com/search?q=hello%20%26%20world');
    
    expect(expandMacro('@google_search', 'test?param=value'))
      .toBe('https://www.google.com/search?q=test%3Fparam%3Dvalue');
    
    expect(expandMacro('@google_search', 'C++ programming'))
      .toBe('https://www.google.com/search?q=C%2B%2B%20programming');
  });

  test('empty query is handled', () => {
    expect(expandMacro('@google_search', ''))
      .toBe('https://www.google.com/search?q=');
    
    expect(expandMacro('@google_search', null))
      .toBe('https://www.google.com/search?q=');
    
    expect(expandMacro('@google_search', undefined))
      .toBe('https://www.google.com/search?q=');
  });

  test('unknown macro returns null', () => {
    expect(expandMacro('@unknown_macro', 'test')).toBeNull();
    expect(expandMacro('@fake_search', 'query')).toBeNull();
    expect(expandMacro('google_search', 'no @ prefix')).toBeNull();
  });

  test('unicode characters are encoded', () => {
    expect(expandMacro('@google_search', '日本語'))
      .toBe('https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E');
    
    expect(expandMacro('@google_search', 'café'))
      .toBe('https://www.google.com/search?q=caf%C3%A9');
  });
});
