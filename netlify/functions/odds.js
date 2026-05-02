// Server-side proxy for live in-play NBA game-winner probability via Kalshi.
//
// Why a proxy: Kalshi's API serves CORS-restricted responses to browsers,
// and we want to reshape the payload (only return what we need) and add
// caching headers Netlify's CDN can use.
//
// What it returns:
//   {
//     home: "ORL", away: "DET",
//     match: { homeMarket: {...}, awayMarket: {...} } | null,
//     debug: { totalNbaMarkets, sampleTickers, matchedTickers }
//   }
//
// First-deploy debug: if `match` is null, inspect `debug.sampleTickers` in
// the browser console — those are the actual Kalshi ticker formats currently
// open, which tells us how to refine the team-matching logic.

const RESP_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=20",
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ESPN abbr → words that may appear in Kalshi market titles or tickers
const TEAM_NAME_FRAGMENTS = {
  ATL: ["ATL", "HAWKS", "ATLANTA"],
  BOS: ["BOS", "CELTICS", "BOSTON"],
  BKN: ["BKN", "BRK", "NETS", "BROOKLYN"],
  CHA: ["CHA", "CHO", "HORNETS", "CHARLOTTE"],
  CHI: ["CHI", "BULLS", "CHICAGO"],
  CLE: ["CLE", "CAVALIERS", "CAVS", "CLEVELAND"],
  DAL: ["DAL", "MAVERICKS", "MAVS", "DALLAS"],
  DEN: ["DEN", "NUGGETS", "DENVER"],
  DET: ["DET", "PISTONS", "DETROIT"],
  GS:  ["GS", "GSW", "WARRIORS", "GOLDEN"],
  HOU: ["HOU", "ROCKETS", "HOUSTON"],
  IND: ["IND", "PACERS", "INDIANA"],
  LAC: ["LAC", "CLIPPERS"],
  LAL: ["LAL", "LAKERS"],
  MEM: ["MEM", "GRIZZLIES", "MEMPHIS"],
  MIA: ["MIA", "HEAT", "MIAMI"],
  MIL: ["MIL", "BUCKS", "MILWAUKEE"],
  MIN: ["MIN", "TIMBERWOLVES", "WOLVES", "MINNESOTA"],
  NO:  ["NO", "NOP", "PELICANS", "ORLEANS"],
  NY:  ["NY", "NYK", "KNICKS"],
  OKC: ["OKC", "THUNDER", "OKLAHOMA"],
  ORL: ["ORL", "MAGIC", "ORLANDO"],
  PHI: ["PHI", "76ERS", "SIXERS", "PHILADELPHIA"],
  PHX: ["PHX", "PHO", "SUNS", "PHOENIX"],
  POR: ["POR", "BLAZERS", "TRAILBLAZERS", "PORTLAND"],
  SAC: ["SAC", "KINGS", "SACRAMENTO"],
  SA:  ["SA", "SAS", "SPURS", "ANTONIO"],
  TOR: ["TOR", "RAPTORS", "TORONTO"],
  UTAH:["UTAH", "UTA", "JAZZ"],
  WAS: ["WAS", "WSH", "WIZARDS", "WASHINGTON"],
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const home = (params.home || "").toUpperCase();
  const away = (params.away || "").toUpperCase();
  if (!home || !away) return resp(400, { error: "missing home/away query param" });

  try {
    // Pull all open Kalshi markets and filter client-side. (Their API does
    // support series_ticker filtering, but the sports series ticker varies —
    // searching everything and filtering by team-name match is more robust.)
    const url = "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=1000";
    const r = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": UA },
    });

    if (!r.ok) {
      const preview = (await r.text()).slice(0, 240);
      return resp(r.status, { error: `kalshi responded ${r.status}`, bodyPreview: preview });
    }
    const j = await r.json();
    const markets = Array.isArray(j.markets) ? j.markets : [];

    // Likely NBA tickers: contain "NBA" or are under series like KXNBAGAME, NBAGAME, etc.
    const nbaMarkets = markets.filter(m => {
      const t = (m.ticker || "").toUpperCase();
      const ev = (m.event_ticker || "").toUpperCase();
      const title = (m.title || "").toUpperCase();
      return /NBA/.test(t) || /NBA/.test(ev) || /NBA/.test(title);
    });

    const homeFrags = TEAM_NAME_FRAGMENTS[home] || [home];
    const awayFrags = TEAM_NAME_FRAGMENTS[away] || [away];

    // For a "Pistons @ Magic" game we expect Kalshi has two markets:
    //   one whose YES means "Pistons win"
    //   one whose YES means "Magic win"
    // Identify by yes_sub_title (most reliable) or by ticker fragments.
    const matchHome = (m) => containsAny(m.yes_sub_title, homeFrags) || containsAny(m.ticker, homeFrags);
    const matchAway = (m) => containsAny(m.yes_sub_title, awayFrags) || containsAny(m.ticker, awayFrags);

    // Restrict to markets where BOTH team fragments appear somewhere — that's
    // a single game's market list. Then pick the one whose YES is each team.
    const gameMarkets = nbaMarkets.filter(m => {
      const blob = `${m.ticker || ""} ${m.event_ticker || ""} ${m.title || ""}`.toUpperCase();
      return containsAny(blob, homeFrags) && containsAny(blob, awayFrags);
    });

    const homeMarket = gameMarkets.find(matchHome) || null;
    const awayMarket = gameMarkets.find(matchAway) || null;

    return resp(200, {
      home, away,
      match: (homeMarket || awayMarket)
        ? { homeMarket: snap(homeMarket), awayMarket: snap(awayMarket) }
        : null,
      debug: {
        totalOpenMarkets: markets.length,
        totalNbaMarkets: nbaMarkets.length,
        gameMarketsFound: gameMarkets.length,
        sampleTickers: nbaMarkets.slice(0, 12).map(m => ({
          ticker: m.ticker, yes_sub_title: m.yes_sub_title, title: m.title,
        })),
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return resp(502, { error: "proxy fetch failed: " + e.message });
  }
};

function snap(m) {
  if (!m) return null;
  return {
    ticker: m.ticker,
    title: m.title,
    yesSubtitle: m.yes_sub_title,
    yesBid: m.yes_bid,        // cents; implied prob ~ value/100
    yesAsk: m.yes_ask,
    lastPrice: m.last_price,
    volume: m.volume,
    closeTime: m.close_time,
    status: m.status,
  };
}

function containsAny(haystack, needles) {
  if (!haystack) return false;
  const h = String(haystack).toUpperCase();
  return needles.some(n => h.includes(n));
}

function resp(code, body) {
  return { statusCode: code, headers: RESP_HEADERS, body: JSON.stringify(body) };
}
