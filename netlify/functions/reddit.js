// Server-side Reddit proxy.
// Reddit blocks browser-origin fetches via CORS. This function fetches the
// requested Reddit JSON URL server-side and returns it as JSON. If Reddit
// responds with HTML (rate-limit page, anti-bot block), we surface a
// structured JSON error instead of piping the HTML through.

const RESP_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=20",
};

// Real desktop Chrome UA — Reddit's anti-bot is far more permissive of these
// than custom/empty UAs. Reddit's TOS allows public JSON endpoints.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

exports.handler = async (event) => {
  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) return resp(400, { error: "missing url" });

  let parsed;
  try { parsed = new URL(target); } catch { return resp(400, { error: "bad url" }); }
  if (!/(^|\.)reddit\.com$/.test(parsed.hostname) || !parsed.pathname.endsWith(".json")) {
    return resp(400, { error: "url must be a reddit *.json endpoint" });
  }

  try {
    const r = await fetch(target, {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    const text = await r.text();
    const ct = r.headers.get("content-type") || "";

    // Quick sanity check: does this look like JSON?
    const trimmed = text.trim();
    const looksJSON = trimmed.startsWith("{") || trimmed.startsWith("[");

    if (!r.ok) {
      return resp(r.status, {
        error: `reddit responded ${r.status}`,
        contentType: ct,
        bodyPreview: text.slice(0, 240),
      });
    }
    if (!looksJSON) {
      // Reddit served an HTML challenge / rate-limit page
      return resp(502, {
        error: "reddit returned non-JSON (likely rate-limit or anti-bot page)",
        contentType: ct,
        bodyPreview: text.slice(0, 240),
      });
    }

    return {
      statusCode: 200,
      headers: RESP_HEADERS,
      body: text,
    };
  } catch (e) {
    return resp(502, { error: "proxy fetch failed: " + e.message });
  }
};

function resp(code, body) {
  return { statusCode: code, headers: RESP_HEADERS, body: JSON.stringify(body) };
}
