// Server-side odds proxy with multi-source fallback.
//
// We attempt sources in order of preference for live in-play odds:
//   1. DraftKings public sportsbook JSON (best for live in-play)
//   2. Bovada public coupon API (also has live in-play, more permissive)
//   3. ESPN pickcenter (opening lines only — last resort)
//
// We try DraftKings with a few different state-specific endpoints because
// the generic one frequently 403s datacenter IPs while state subdomains
// are sometimes more permissive.
//
// The response shape is normalized so the front-end doesn't care which
// source it came from:
//   { found, source, isLive, spread, total, homeML, awayML,
//     homeSpreadOdds, awaySpreadOdds, eventName, attempts: [...] }

const RESP_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=20",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ESPN abbr → name fragments seen in sportsbook event titles
const TEAM_NAME_FRAGMENTS = {
  ATL: ["HAWKS"], BOS: ["CELTICS"], BKN: ["NETS"], CHA: ["HORNETS"],
  CHI: ["BULLS"], CLE: ["CAVALIERS", "CAVS"], DAL: ["MAVERICKS", "MAVS"],
  DEN: ["NUGGETS"], DET: ["PISTONS"], GS:  ["WARRIORS"], HOU: ["ROCKETS"],
  IND: ["PACERS"], LAC: ["CLIPPERS"], LAL: ["LAKERS"], MEM: ["GRIZZLIES"],
  MIA: ["HEAT"], MIL: ["BUCKS"], MIN: ["TIMBERWOLVES", "WOLVES"],
  NO:  ["PELICANS"], NY:  ["KNICKS"], OKC: ["THUNDER"], ORL: ["MAGIC"],
  PHI: ["76ERS", "SIXERS"], PHX: ["SUNS"], POR: ["TRAIL BLAZERS", "BLAZERS"],
  SAC: ["KINGS"], SA:  ["SPURS"], TOR: ["RAPTORS"], UTAH:["JAZZ"], WAS: ["WIZARDS"],
};

const DK_NBA_EVENT_GROUP = 42648;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const home = (params.home || "").toUpperCase();
  const away = (params.away || "").toUpperCase();
  if (!home || !away) return resp(400, { error: "missing home/away query param" });

  const homeFrags = TEAM_NAME_FRAGMENTS[home] || [home];
  const awayFrags = TEAM_NAME_FRAGMENTS[away] || [away];
  const attempts = [];

  // 1. DraftKings — try a couple of state subdomains since the generic one
  //    frequently returns 403 to datacenter IPs.
  for (const sub of ["sportsbook-nash-co", "sportsbook-nash-nj", "sportsbook-nash-va", "sportsbook-nash"]) {
    const r = await tryDraftKings(sub, homeFrags, awayFrags);
    attempts.push({ source: `DraftKings (${sub})`, status: r.status, error: r.error });
    if (r.ok && r.data.found) {
      return resp(200, { ...r.data, attempts });
    }
  }

  // 2. Bovada — public sportsbook with live in-play odds
  const bv = await tryBovada(homeFrags, awayFrags);
  attempts.push({ source: "Bovada", status: bv.status, error: bv.error });
  if (bv.ok && bv.data.found) return resp(200, { ...bv.data, attempts });

  // 3. ESPN pickcenter — opening lines only (last resort)
  const espn = await tryESPN(home, away, homeFrags, awayFrags);
  attempts.push({ source: "ESPN pickcenter", status: espn.status, error: espn.error });
  if (espn.ok && espn.data.found) return resp(200, { ...espn.data, attempts });

  return resp(502, {
    found: false,
    error: "all sportsbook sources failed",
    attempts,
  });
};

/* ---------- DraftKings ---------- */

async function tryDraftKings(subdomain, homeFrags, awayFrags) {
  const url = `https://${subdomain}.draftkings.com/sites/US-SB/api/v5/eventgroups/${DK_NBA_EVENT_GROUP}?format=json`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://sportsbook.draftkings.com/leagues/basketball/nba",
        "Origin": "https://sportsbook.draftkings.com",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      },
    });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    const j = await r.json();
    const eg = j.eventGroup || {};
    const events = Array.isArray(eg.events) ? eg.events : [];
    const eventIdx = events.findIndex(e => {
      const blob = `${e.name || ""} ${e.teamName1 || ""} ${e.teamName2 || ""}`.toUpperCase();
      return containsAny(blob, homeFrags) && containsAny(blob, awayFrags);
    });
    if (eventIdx < 0) return { ok: true, status: 200, data: { found: false, source: "DraftKings", reason: "no event match" } };
    const ev = events[eventIdx];
    const isLive = !!(ev.eventStatus && (ev.eventStatus.state === "STARTED" || ev.eventStatus.state === "LIVE"));
    const lines = extractDKLines(eg, eventIdx, homeFrags, awayFrags);
    return {
      ok: true, status: 200,
      data: { found: true, source: "DraftKings", isLive, eventName: ev.name, eventId: ev.eventId, ...lines },
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

function extractDKLines(eg, eventIdx, homeFrags, awayFrags) {
  const out = { spread: null, total: null, homeML: null, awayML: null, homeSpreadOdds: null, awaySpreadOdds: null };
  const cats = Array.isArray(eg.offerCategories) ? eg.offerCategories : [];
  for (const cat of cats) {
    const descs = Array.isArray(cat.offerSubcategoryDescriptors) ? cat.offerSubcategoryDescriptors : [];
    for (const desc of descs) {
      const sub = desc.offerSubcategory || {};
      const offerGroups = Array.isArray(sub.offers) ? sub.offers : [];
      const offers = offerGroups[eventIdx];
      if (!Array.isArray(offers)) continue;
      for (const offer of offers) applyDKOffer(offer, out, homeFrags, awayFrags);
    }
  }
  return out;
}

function applyDKOffer(offer, out, homeFrags, awayFrags) {
  if (!offer || !Array.isArray(offer.outcomes)) return;
  const label = (offer.label || "").toLowerCase();
  if (label.includes("spread") || label.includes("point")) {
    for (const o of offer.outcomes) {
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
        if (out.spread == null) out.spread = -line;
      }
    }
  } else if (label.includes("moneyline") || label.includes("money line")) {
    for (const o of offer.outcomes) {
      const olabel = (o.label || o.participant || "").toUpperCase();
      const isHome = containsAny(olabel, homeFrags);
      const isAway = containsAny(olabel, awayFrags);
      const odds = parseInt(o.oddsAmerican, 10);
      if (isNaN(odds)) continue;
      if (isHome && out.homeML == null) out.homeML = odds;
      else if (isAway && out.awayML == null) out.awayML = odds;
    }
  } else if (label.includes("total") || label.includes("over/under")) {
    for (const o of offer.outcomes) {
      const line = parseFloat(o.line);
      if (!isNaN(line) && out.total == null) { out.total = line; break; }
    }
  }
}

/* ---------- Bovada ---------- */

async function tryBovada(homeFrags, awayFrags) {
  // Includes both pre-game and live games
  const url = "https://www.bovada.lv/services/sports/event/coupon/events/A/description/basketball/nba?marketFilterId=def&preMatchOnly=false&lang=en";
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.bovada.lv/sports/basketball/nba",
      },
    });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    const j = await r.json();
    // Bovada returns an array of "event groups"; flatten all events.
    const groups = Array.isArray(j) ? j : [];
    const events = [];
    for (const g of groups) {
      const evs = Array.isArray(g.events) ? g.events : [];
      events.push(...evs);
    }
    const ev = events.find(e => {
      const blob = `${e.description || ""} ${(e.competitors || []).map(c => c.name).join(" ")}`.toUpperCase();
      return containsAny(blob, homeFrags) && containsAny(blob, awayFrags);
    });
    if (!ev) return { ok: true, status: 200, data: { found: false, source: "Bovada", reason: "no event match" } };

    const homeComp = (ev.competitors || []).find(c => c.home);
    const lines = extractBovadaLines(ev, homeFrags, awayFrags);
    return {
      ok: true, status: 200,
      data: {
        found: true, source: "Bovada",
        isLive: !!ev.live,
        eventName: ev.description,
        eventId: ev.id,
        ...lines,
      },
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

function extractBovadaLines(ev, homeFrags, awayFrags) {
  const out = { spread: null, total: null, homeML: null, awayML: null, homeSpreadOdds: null, awaySpreadOdds: null };
  const groups = Array.isArray(ev.displayGroups) ? ev.displayGroups : [];
  for (const g of groups) {
    const markets = Array.isArray(g.markets) ? g.markets : [];
    for (const m of markets) {
      const desc = (m.description || "").toLowerCase();
      const period = (m.period && m.period.description) || "";
      // Only main game markets, not quarter/half markets
      if (period && !/match|game|full/i.test(period)) continue;
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];

      if (desc.includes("spread") || desc.includes("point") || desc.includes("runline")) {
        for (const o of outcomes) {
          const olabel = (o.description || "").toUpperCase();
          const isHome = containsAny(olabel, homeFrags);
          const isAway = containsAny(olabel, awayFrags);
          const line = parseFloat(o.price && o.price.handicap);
          const odds = parseInt(o.price && o.price.american, 10);
          if (isNaN(line)) continue;
          if (isHome && out.spread == null) {
            out.spread = line;
            if (!isNaN(odds)) out.homeSpreadOdds = odds;
          } else if (isAway) {
            if (!isNaN(odds)) out.awaySpreadOdds = odds;
            if (out.spread == null) out.spread = -line;
          }
        }
      } else if (desc.includes("moneyline") || desc === "money line") {
        for (const o of outcomes) {
          const olabel = (o.description || "").toUpperCase();
          const isHome = containsAny(olabel, homeFrags);
          const isAway = containsAny(olabel, awayFrags);
          const odds = parseInt(o.price && o.price.american, 10);
          if (isNaN(odds)) continue;
          if (isHome && out.homeML == null) out.homeML = odds;
          else if (isAway && out.awayML == null) out.awayML = odds;
        }
      } else if (desc.includes("total") || desc.includes("over/under")) {
        for (const o of outcomes) {
          const line = parseFloat(o.price && o.price.handicap);
          if (!isNaN(line) && out.total == null) { out.total = line; break; }
        }
      }
    }
  }
  return out;
}

/* ---------- ESPN pickcenter (last-resort: opening lines) ---------- */

async function tryESPN(home, away, homeFrags, awayFrags) {
  // ESPN doesn't let us look up events by team — we'd need eventId. Skip
  // the heavy fallback and let the front-end label the failure clearly.
  // (Front-end already had its own ESPN fallback path before this rewrite.)
  return { ok: false, status: 0, error: "espn lookup-by-team not implemented" };
}

/* ---------- helpers ---------- */

function containsAny(haystack, needles) {
  if (!haystack) return false;
  const h = String(haystack).toUpperCase();
  return needles.some(n => h.includes(n));
}

function resp(code, body) {
  return { statusCode: code, headers: RESP_HEADERS, body: JSON.stringify(body) };
}
