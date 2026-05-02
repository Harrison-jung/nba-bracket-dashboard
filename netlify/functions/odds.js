// Server-side proxy for DraftKings public NBA sportsbook lines.
//
// DraftKings exposes a public sportsbook JSON feed (no auth required) but
// blocks browser CORS. We proxy server-side and return a clean, normalized
// shape: spread / money line / total, with `isLive` flag so the UI can label
// pre-game vs. in-play.

const RESP_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=20",
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// DraftKings NBA event group id. Stable; changes only if league structure shifts.
const DK_NBA_EVENT_GROUP = 42648;

// ESPN abbr → name fragments that may appear in DraftKings event/outcome labels
const TEAM_NAME_FRAGMENTS = {
  ATL: ["HAWKS", "ATLANTA"],
  BOS: ["CELTICS", "BOSTON"],
  BKN: ["NETS", "BROOKLYN"],
  CHA: ["HORNETS", "CHARLOTTE"],
  CHI: ["BULLS", "CHICAGO"],
  CLE: ["CAVALIERS", "CAVS", "CLEVELAND"],
  DAL: ["MAVERICKS", "MAVS", "DALLAS"],
  DEN: ["NUGGETS", "DENVER"],
  DET: ["PISTONS", "DETROIT"],
  GS:  ["WARRIORS", "GOLDEN STATE"],
  HOU: ["ROCKETS", "HOUSTON"],
  IND: ["PACERS", "INDIANA"],
  LAC: ["CLIPPERS"],
  LAL: ["LAKERS"],
  MEM: ["GRIZZLIES", "MEMPHIS"],
  MIA: ["HEAT", "MIAMI"],
  MIL: ["BUCKS", "MILWAUKEE"],
  MIN: ["TIMBERWOLVES", "MINNESOTA"],
  NO:  ["PELICANS", "NEW ORLEANS"],
  NY:  ["KNICKS", "NEW YORK"],
  OKC: ["THUNDER", "OKLAHOMA"],
  ORL: ["MAGIC", "ORLANDO"],
  PHI: ["76ERS", "SIXERS", "PHILADELPHIA"],
  PHX: ["SUNS", "PHOENIX"],
  POR: ["BLAZERS", "TRAIL BLAZERS", "PORTLAND"],
  SAC: ["KINGS", "SACRAMENTO"],
  SA:  ["SPURS", "SAN ANTONIO"],
  TOR: ["RAPTORS", "TORONTO"],
  UTAH:["JAZZ", "UTAH"],
  WAS: ["WIZARDS", "WASHINGTON"],
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const home = (params.home || "").toUpperCase();
  const away = (params.away || "").toUpperCase();
  if (!home || !away) return resp(400, { error: "missing home/away query param" });

  try {
    const url = `https://sportsbook-nash.draftkings.com/sites/US-SB/api/v5/eventgroups/${DK_NBA_EVENT_GROUP}?format=json`;
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://sportsbook.draftkings.com/",
      },
    });

    if (!r.ok) {
      const preview = (await r.text()).slice(0, 240);
      return resp(r.status, { error: `dk responded ${r.status}`, bodyPreview: preview });
    }
    const j = await r.json();
    const eg = j.eventGroup || {};
    const events = Array.isArray(eg.events) ? eg.events : [];

    const homeFrags = TEAM_NAME_FRAGMENTS[home] || [home];
    const awayFrags = TEAM_NAME_FRAGMENTS[away] || [away];

    // Find the event matching our two teams
    const eventIdx = events.findIndex(e => {
      const blob = `${e.name || ""} ${e.teamName1 || ""} ${e.teamName2 || ""}`.toUpperCase();
      return containsAny(blob, homeFrags) && containsAny(blob, awayFrags);
    });

    if (eventIdx < 0) {
      return resp(404, {
        found: false,
        error: "no DraftKings event matched these teams",
        searched: { home, away },
        sampleEvents: events.slice(0, 8).map(e => e.name),
      });
    }

    const ev = events[eventIdx];
    const isLive = !!(ev.eventStatus && (ev.eventStatus.state === "STARTED" || ev.eventStatus.state === "LIVE"));
    const lines = extractLines(eg, eventIdx, homeFrags, awayFrags);

    return resp(200, {
      found: true,
      source: "DraftKings",
      eventName: ev.name,
      eventId: ev.eventId,
      isLive,
      ...lines,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return resp(502, { error: "proxy fetch failed: " + e.message });
  }
};

// Walk DraftKings' offerCategories → offerSubcategoryDescriptors → offerSubcategory.offers
// to extract spread/moneyLine/total for the event at `eventIdx`.
// `offers` is an array-of-arrays; outer index = event index in eg.events.
function extractLines(eg, eventIdx, homeFrags, awayFrags) {
  const out = {
    spread: null,         // home spread (negative = home favored)
    total: null,
    homeML: null,
    awayML: null,
    homeSpreadOdds: null,
    awaySpreadOdds: null,
  };
  const cats = Array.isArray(eg.offerCategories) ? eg.offerCategories : [];
  for (const cat of cats) {
    const descs = Array.isArray(cat.offerSubcategoryDescriptors) ? cat.offerSubcategoryDescriptors : [];
    for (const desc of descs) {
      const sub = desc.offerSubcategory || {};
      const offerGroups = Array.isArray(sub.offers) ? sub.offers : [];
      const offers = offerGroups[eventIdx];
      if (!Array.isArray(offers)) continue;
      for (const offer of offers) {
        applyOffer(offer, out, homeFrags, awayFrags);
      }
    }
  }
  return out;
}

function applyOffer(offer, out, homeFrags, awayFrags) {
  if (!offer || !Array.isArray(offer.outcomes)) return;
  const label = (offer.label || "").toLowerCase();
  const outcomes = offer.outcomes;

  // SPREAD
  if (label.includes("spread") || label.includes("point")) {
    for (const o of outcomes) {
      const olabel = (o.label || o.participant || "").toUpperCase();
      const isHome = containsAny(olabel, homeFrags);
      const isAway = containsAny(olabel, awayFrags);
      const line = parseFloat(o.line);
      const odds = parseInt(o.oddsAmerican, 10);
      if (isNaN(line)) continue;
      if (isHome && out.spread == null) {
        out.spread = line;
        if (!isNaN(odds)) out.homeSpreadOdds = odds;
      } else if (isAway) {
        if (!isNaN(odds)) out.awaySpreadOdds = odds;
        if (out.spread == null) out.spread = -line; // derive home spread from away
      }
    }
    return;
  }

  // MONEY LINE
  if (label.includes("moneyline") || label.includes("money line") || label === "moneyline") {
    for (const o of outcomes) {
      const olabel = (o.label || o.participant || "").toUpperCase();
      const isHome = containsAny(olabel, homeFrags);
      const isAway = containsAny(olabel, awayFrags);
      const odds = parseInt(o.oddsAmerican, 10);
      if (isNaN(odds)) continue;
      if (isHome && out.homeML == null) out.homeML = odds;
      else if (isAway && out.awayML == null) out.awayML = odds;
    }
    return;
  }

  // TOTAL (Over/Under)
  if (label.includes("total") || label.includes("over/under") || label.includes("o/u")) {
    for (const o of outcomes) {
      const line = parseFloat(o.line);
      if (!isNaN(line) && out.total == null) {
        out.total = line;
        break;
      }
    }
    return;
  }
}

function containsAny(haystack, needles) {
  if (!haystack) return false;
  const h = String(haystack).toUpperCase();
  return needles.some(n => h.includes(n));
}

function resp(code, body) {
  return { statusCode: code, headers: RESP_HEADERS, body: JSON.stringify(body) };
}
