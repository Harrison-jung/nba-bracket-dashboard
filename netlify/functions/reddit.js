// Server-side Reddit proxy.
// Reddit blocks browser-origin fetches via CORS, but it's happy to talk to
// our Netlify Function (which runs from a Netlify datacenter and sets a
// proper User-Agent). The dashboard calls this with ?url=<reddit-json-url>
// and we pipe the response straight back as JSON.

exports.handler = async (event) => {
  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) {
    return { statusCode: 400, body: JSON.stringify({ error: "missing url" }) };
  }
  // Safety: only allow public reddit JSON endpoints
  let parsed;
  try { parsed = new URL(target); } catch { return resp(400, { error: "bad url" }); }
  if (!/(^|\.)reddit\.com$/.test(parsed.hostname) || !parsed.pathname.endsWith(".json")) {
    return resp(400, { error: "url must be a reddit *.json endpoint" });
  }

  try {
    const r = await fetch(target, {
      headers: {
        // A descriptive UA — Reddit's anti-bot heuristics treat real-looking UAs much better than empty/proxy ones.
        "User-Agent": "nba-bracket-dashboard/1.0 (by /u/harrisonjung)",
        "Accept": "application/json",
      },
    });
    const text = await r.text();
    return {
      statusCode: r.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=20",
      },
      body: text,
    };
  } catch (e) {
    return resp(502, { error: "proxy fetch failed: " + e.message });
  }
};

function resp(code, body) {
  return {
    statusCode: code,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
