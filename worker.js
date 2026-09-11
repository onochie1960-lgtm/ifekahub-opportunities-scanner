/**
 * IfekaHub Opportunity Scanner
 * Cloudflare Worker + Supabase REST API
 *
 * Required Cloudflare secrets/variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SCAN_TOKEN
 *
 * Optional:
 *   MAX_ITEMS_PER_SOURCE   (default: 10)
 *   REQUEST_TIMEOUT_MS     (default: 15000)
 *
 * New findings are saved as:
 *   approval_status = pending
 *   is_active       = false
 *   published       = false
 *   featured        = false
 *
 * POST /scan
 *   Authorization: Bearer <SCAN_TOKEN>
 *
 * GET /health
 * GET /supabase-test
 */

const SOURCES = [
  ["Jobberman", "jobs", "https://www.jobberman.com/jobs"],
  ["MyJobMag", "jobs", "https://www.myjobmag.com/jobs"],
  ["SMEDAN Programmes", "grants", "https://smedan.gov.ng/our-programs/"],
  ["SMEDAN Conditional Grant Scheme", "grants", "https://smedan.gov.ng/our-programs/cgs/"],
  ["Federal Scholarship Board", "scholarships", "https://education.gov.ng/federal-scholarships-board/"],
  ["Federal Scholarship Portal", "scholarships", "https://scholarship.education.gov.ng/scholarships"],
  ["Bank of Industry", "funding", "https://www.boi.ng/"],
  ["BOI MSME Support", "funding", "https://www.boi.ng/who-we-serve/msmes/"],
  ["BOI Intervention Funds", "funding", "https://www.boi.ng/impact/intervention-funds/"]
];

const LABEL = {
  jobs: "Jobs",
  grants: "Grants & Funding",
  funding: "Grants & Funding",
  scholarships: "Scholarships",
  training: "Training"
};

const BAD_EXACT = new Set([
  "login",
  "sign in",
  "register",
  "privacy",
  "cookie",
  "terms",
  "contact us",
  "about us",
  "facebook",
  "twitter",
  "instagram",
  "youtube",
  "read more",
  "home",
  "menu",
  "search"
]);

const BAD_PATH = [
  "/login",
  "/signin",
  "/register",
  "/privacy",
  "/terms",
  "/contact",
  "/about",
  "/category/",
  "/tag/",
  "/author/"
];

const OPPORTUNITY_WORDS = [
  "job",
  "jobs",
  "career",
  "careers",
  "vacancy",
  "vacancies",
  "recruit",
  "recruitment",
  "hiring",
  "employment",
  "grant",
  "grants",
  "funding",
  "finance",
  "financing",
  "loan",
  "support",
  "intervention",
  "programme",
  "program",
  "scholarship",
  "fellowship",
  "bursary",
  "studentship",
  "training",
  "bootcamp",
  "workshop",
  "course",
  "academy",
  "internship",
  "intern",
  "application",
  "apply",
  "opportunity"
];

const DEADLINE_WORDS = [
  "deadline",
  "closing date",
  "application closes",
  "applications close",
  "apply before",
  "apply by",
  "submission deadline",
  "closing"
];

const APPLICATION_WORDS = [
  "apply",
  "application",
  "register",
  "submit",
  "how to apply",
  "apply now",
  "start application"
];

function clean(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#8217;|&#x2019;/gi, "'")
    .replace(/&#8211;|&#x2013;/gi, "-")
    .replace(/&#8212;|&#x2014;/gi, "-")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return " ";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, base) {
  try {
    const value = String(href || "").trim();

    if (
      !value ||
      value.startsWith("#") ||
      /^javascript:/i.test(value) ||
      /^mailto:/i.test(value)
    ) {
      return "";
    }

    return new URL(value, base).href;
  } catch {
    return "";
  }
}

function normalizedUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";

    return u.href.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(url || "")
      .split("#")[0]
      .replace(/\/+$/, "")
      .toLowerCase();
  }
}

function sameHost(a, b) {
  try {
    return (
      new URL(a).hostname.replace(/^www\./, "") ===
      new URL(b).hostname.replace(/^www\./, "")
    );
  } catch {
    return false;
  }
}

function usefulTitle(title) {
  const t = normalizeSpace(title);

  if (t.length < 8 || t.length > 180) {
    return false;
  }

  const lower = t.toLowerCase();

  if (BAD_EXACT.has(lower)) {
    return false;
  }

  return true;
}

function category(title, fallback) {
  const t = String(title || "").toLowerCase();

  if (
    /\b(job|jobs|career|careers|vacanc|recruit|employment|hiring)\b/.test(t)
  ) {
    return "jobs";
  }

  if (
    /\b(scholarship|scholarships|fellowship|fellowships|bursary|studentship)\b/.test(
      t
    )
  ) {
    return "scholarships";
  }

  if (
    /\b(training|bootcamp|workshop|capacity building|course|academy|internship)\b/.test(
      t
    )
  ) {
    return "training";
  }

  if (
    /\b(grant|grants|funding|finance|financing|loan|support scheme|intervention)\b/.test(
      t
    )
  ) {
    return "funding";
  }

  return fallback;
}

function scoreCandidate(title, context, url, sourceCategory) {
  const text = `${title} ${context} ${url}`.toLowerCase();

  let score = 0;

  if (OPPORTUNITY_WORDS.some(word => text.includes(word))) {
    score += 2;
  }

  if (APPLICATION_WORDS.some(word => text.includes(word))) {
    score += 2;
  }

  if (DEADLINE_WORDS.some(word => text.includes(word))) {
    score += 2;
  }

  if (
    sourceCategory === "jobs" &&
    /\b(job|career|vacanc|hiring|recruit)\b/.test(text)
  ) {
    score += 2;
  }

  if (
    sourceCategory === "grants" &&
    /\b(grant|funding|support|programme|program)\b/.test(text)
  ) {
    score += 2;
  }

  if (
    sourceCategory === "funding" &&
    /\b(funding|finance|loan|support|intervention|msme)\b/.test(text)
  ) {
    score += 2;
  }

  if (
    sourceCategory === "scholarships" &&
    /\b(scholarship|fellowship|bursary|student)\b/.test(text)
  ) {
    score += 2;
  }

  if (
    /\b(contact|privacy|cookie|terms|about us|login|sign in)\b/.test(
      title.toLowerCase()
    )
  ) {
    score -= 5;
  }

  if (
    BAD_PATH.some(path => {
      try {
        return new URL(url).pathname.toLowerCase().startsWith(path);
      } catch {
        return false;
      }
    })
  ) {
    score -= 5;
  }

  return score;
}

function parseDateParts(day, month, year) {
  const months = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,

    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };

  const d = Number(day);
  let y = Number(year);

  const m =
    typeof month === "number"
      ? month
      : months[String(month).toLowerCase()];

  if (
    !Number.isInteger(d) ||
    !Number.isInteger(y) ||
    !Number.isInteger(m)
  ) {
    return null;
  }

  if (y < 100) {
    y += 2000;
  }

  const date = new Date(Date.UTC(y, m, d));

  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function deadline(text) {
  const value = clean(text);

  const patterns = [
    /(?:deadline|closing date|application closes?|applications close|apply before|apply by|submission deadline|closing)\s*[:\-]?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/i,

    /(?:deadline|closing date|application closes?|applications close|apply before|apply by|submission deadline|closing)\s*[:\-]?\s*([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i,

    /(?:deadline|closing date|application closes?|applications close|apply before|apply by|submission deadline|closing)\s*[:\-]?\s*(\d{1,2})\s+([A-Z][a-z]+)\s+(\d{4})/i,

    /(?:deadline|closing date|application closes?|applications close|apply before|apply by|submission deadline|closing)[^\d]{0,40}(\d{1,2})\s+([A-Z][a-z]{2,9})\s+(\d{4})/i,

    /(?:deadline|closing date|application closes?|applications close|apply before|apply by|submission deadline|closing)[^\d]{0,40}([A-Z][a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (!match) {
      continue;
    }

    let result = null;

    if (/^\d+$/.test(match[1]) && /^\d+$/.test(match[2])) {
      result = parseDateParts(
        match[1],
        Number(match[2]) - 1,
        match[3]
      );
    } else if (/^\d+$/.test(match[2])) {
      result = parseDateParts(
        match[2],
        match[1],
        match[3]
      );
    } else {
      result = parseDateParts(
        match[1],
        match[2],
        match[3]
      );
    }

    if (result) {
      return result;
    }
  }

  return null;
}

function extractMeta(html, baseUrl) {
  const result = {
    title: "",
    description: "",
    image: ""
  };

  const titleMatch = html.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i
  );

  if (titleMatch) {
    result.title = clean(titleMatch[1]);
  }

  const descMatch = html.match(
    /<meta[^>]+(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*>/i
  );

  if (descMatch) {
    result.description = clean(descMatch[1]);
  }

  const imageMatch = html.match(
    /<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*>/i
  );

  if (imageMatch) {
    result.image = absoluteUrl(
      imageMatch[1],
      baseUrl
    );
  }

  return result;
}

function extractLinks(html, base, source) {
  const results = [];
  const seen = new Set();

  const anchorRegex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = anchorRegex.exec(html))) {
    const title = clean(match[2]);
    const url = absoluteUrl(match[1], base);

    if (!url || !usefulTitle(title)) {
      continue;
    }

    const key = normalizedUrl(url);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);

    const context = clean(
      html.slice(
        Math.max(0, match.index - 700),
        Math.min(
          html.length,
          anchorRegex.lastIndex + 1200
        )
      )
    );

    const score = scoreCandidate(
      title,
      context,
      url,
      source[1]
    );

    if (score < 3) {
      continue;
    }

    results.push({
      title,
      url,
      category: category(
        `${title} ${context}`,
        source[1]
      ),
      context,
      score
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
}

function findBestApplicationUrl(html, pageUrl) {
  const links = [];

  const regex =
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match;

  while ((match = regex.exec(html))) {
    const url = absoluteUrl(
      match[1],
      pageUrl
    );

    const text = clean(match[2]);

    if (!url || !text) {
      continue;
    }

    const lower =
      `${text} ${url}`.toLowerCase();

    if (
      /\b(apply now|apply|application|register|submit application|start application)\b/.test(
        lower
      )
    ) {
      links.push({
        url,
        text
      });
    }
  }

  const sameHostLink = links.find(x =>
    sameHost(x.url, pageUrl)
  );

  return (
    sameHostLink ||
    links[0] ||
    {}
  ).url || pageUrl;
}

async function fetchText(url, options = {}) {
  const timeoutMs = Number(
    options.timeoutMs || 15000
  );

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,

      headers: {
        "User-Agent":
          "IfekaHub-OpportunityScanner/2.0",

        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

        "Accept-Language":
          "en-NG,en;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return {
      html: await response.text(),
      finalUrl: response.url || url,
      status: response.status
    };
  } finally {
    clearTimeout(timer);
  }
}

async function supabase(
  env,
  path,
  options = {}
) {
  const base = String(
    env.SUPABASE_URL || ""
  ).replace(/\/+$/, "");

  const key = String(
    env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

  if (!base || !key) {
    throw new Error(
      "Supabase bindings are not configured."
    );
  }

  const response = await fetch(
    `${base}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: key,

        Authorization:
          `Bearer ${key}`,

        "Content-Type":
          "application/json",

        Prefer:
          "return=representation",

        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text.slice(
        0,
        800
      )}`
    );
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function ensureSources(env) {
  for (const source of SOURCES) {
    try {
      const existing =
        await supabase(
          env,

          `opportunity_sources?select=id&source_url=eq.${encodeURIComponent(
            source[2]
          )}&limit=1`,

          {
            method: "GET"
          }
        );

      if (
        Array.isArray(existing) &&
        existing.length > 0
      ) {
        continue;
      }

      await supabase(
        env,
        "opportunity_sources",
        {
          method: "POST",

          body: JSON.stringify({
            name: source[0],
            category: source[1],

            icon:
              source[1] === "jobs"
                ? "💼"
                : source[1] ===
                    "scholarships"
                  ? "🎓"
                  : source[1] ===
                      "training"
                    ? "📚"
                    : "💰",

            description:
              "Source monitored by IfekaHub.",

            source_url: source[2],

            is_active: true
          })
        }
      );
    } catch (error) {
      console.log(
        "Source setup warning:",
        source[0],
        error.message
      );
    }
  }
}

async function findDuplicate(
  env,
  url
) {
  const encoded =
    encodeURIComponent(url);

  const rows =
    await supabase(
      env,

      `opportunities?select=id,title,application_url&application_url=eq.${encoded}&limit=1`,

      {
        method: "GET"
      }
    );

  return Array.isArray(rows) &&
    rows.length > 0
    ? rows[0]
    : null;
}

async function saveOpportunity(
  env,
  source,
  item
) {
  const duplicate =
    await findDuplicate(
      env,
      item.url
    );

  if (duplicate) {
    return {
      action: "duplicate",
      id: duplicate.id,
      title:
        duplicate.title ||
        item.title
    };
  }

  let pageDetails = {
    description: "",
    image: "",
    applicationUrl: item.url,
    deadline:
      deadline(item.context)
  };

  try {
    const page =
      await fetchText(
        item.url,
        {
          timeoutMs: Number(
            env.REQUEST_TIMEOUT_MS ||
              15000
          )
        }
      );

    const meta =
      extractMeta(
        page.html,
        page.finalUrl
      );

    const pageText =
      clean(page.html);

    pageDetails.description =
      meta.description ||
      pageText.slice(0, 1800);

    pageDetails.image =
      meta.image || "";

    pageDetails.applicationUrl =
      findBestApplicationUrl(
        page.html,
        page.finalUrl
      );

    pageDetails.deadline =
      deadline(pageText) ||
      pageDetails.deadline;
  } catch (error) {
    console.log(
      "Opportunity page inspection warning:",
      item.url,
      error.message
    );
  }

  const record = {
    title: item.title,

    provider: source[0],

    category:
      LABEL[item.category] ||
      LABEL[source[1]] ||
      "Other",

    location:
      "Nigeria / Online",

    description:
      normalizeSpace(
        pageDetails.description ||
          item.context
      ).slice(0, 1800) ||
      `Opportunity discovered from ${source[0]}.`,

    deadline:
      pageDetails.deadline,

    application_url:
      pageDetails.applicationUrl ||
      item.url,

    source:
      source[2],

    featured: false,

    is_active: false,

    approval_status:
      "pending",

    published: false
  };

  if (pageDetails.image) {
    record.image_url =
      pageDetails.image;
  }

  try {
    const rows =
      await supabase(
        env,
        "opportunities",
        {
          method: "POST",

          body: JSON.stringify({
            ...record,
            status: "Pending"
          })
        }
      );

    return {
      action: "inserted",

      id:
        Array.isArray(rows) &&
        rows[0]
          ? rows[0].id
          : null,

      title: item.title,

      category:
        record.category,

      source:
        source[0],

      deadline:
        record.deadline
    };
  } catch (error) {
    console.log(
      "Primary insert failed, trying compatibility insert:",
      error.message
    );

    const fallback = {
      ...record
    };

    delete fallback.status;
    delete fallback.image_url;

    const rows =
      await supabase(
        env,
        "opportunities",
        {
          method: "POST",

          body:
            JSON.stringify(
              fallback
            )
        }
      );

    return {
      action: "inserted",

      id:
        Array.isArray(rows) &&
        rows[0]
          ? rows[0].id
          : null,

      title:
        item.title,

      category:
        record.category,

      source:
        source[0],

      deadline:
        record.deadline
    };
  }
}

async function scan(env) {
  const started =
    Date.now();

  await ensureSources(
    env
  );

  const maxItems =
    Math.max(
      1,
      Math.min(
        25,
        Number(
          env.MAX_ITEMS_PER_SOURCE ||
            10
        )
      )
    );

  const report = {
    ok: true,

    mode:
      "production-safe",

    started_at:
      new Date().toISOString(),

    sources: [],

    inserted: [],

    duplicates: 0,

    skipped: 0,

    errors: []
  };

  for (
    const source of SOURCES
  ) {
    const sourceReport = {
      source: source[0],

      url: source[2],

      found: 0,

      inserted: 0,

      duplicates: 0,

      skipped: 0,

      error: null
    };

    try {
      const response =
        await fetchText(
          source[2],
          {
            timeoutMs:
              Number(
                env.REQUEST_TIMEOUT_MS ||
                  15000
              )
          }
        );

      const meta =
        extractMeta(
          response.html,
          response.finalUrl
        );

      const items =
        extractLinks(
          response.html,
          response.finalUrl,
          source
        ).slice(
          0,
          maxItems
        );

      sourceReport.found =
        items.length;

      if (
        meta.title &&
        scoreCandidate(
          meta.title,
          meta.description,
          response.finalUrl,
          source[1]
        ) >= 5 &&
        !items.some(
          x =>
            normalizedUrl(
              x.url
            ) ===
            normalizedUrl(
              response.finalUrl
            )
        )
      ) {
        items.unshift({
          title:
            meta.title,

          url:
            response.finalUrl,

          category:
            category(
              `${meta.title} ${meta.description}`,
              source[1]
            ),

          context:
            meta.description,

          score: 5
        });
      }

      for (
        const item of items.slice(
          0,
          maxItems
        )
      ) {
        try {
          const result =
            await saveOpportunity(
              env,
              source,
              item
            );

          if (
            result.action ===
            "inserted"
          ) {
            sourceReport.inserted++;

            report.inserted.push(
              result
            );
          } else {
            sourceReport.duplicates++;

            report.duplicates++;
          }
        } catch (error) {
          report.errors.push({
            source:
              source[0],

            title:
              item.title,

            url:
              item.url,

            error:
              error.message
          });
        }
      }

      report.sources.push(
        sourceReport
      );
    } catch (error) {
      sourceReport.error =
        error.message;

      report.errors.push({
        source:
          source[0],

        error:
          error.message
      });

      report.sources.push(
        sourceReport
      );
    }
  }

  report.duration_ms =
    Date.now() - started;

  report.finished_at =
    new Date().toISOString();

  return report;
}

function authorized(
  request,
  env
) {
  const expected =
    String(
      env.SCAN_TOKEN || ""
    ).trim();

  const authorization =
    request.headers.get(
      "Authorization"
    ) || "";

  if (!expected) {
    return false;
  }

  const supplied =
    authorization.startsWith(
      "Bearer "
    )
      ? authorization
          .slice(7)
          .trim()
      : "";

  return supplied === expected;
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,

      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}

export default {
  async fetch(
    request,
    env
  ) {
    const url =
      new URL(
        request.url
      );

    if (
      request.method ===
        "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        "IfekaHub Opportunity Scanner is installed.",
        {
          status: 200,

          headers: {
            "Content-Type":
              "text/plain; charset=UTF-8",

            "Cache-Control":
              "no-store"
          }
        }
      );
    }

    if (
      request.method ===
        "GET" &&
      url.pathname ===
        "/health"
    ) {
      return json({
        ok: true,

        service:
          "ifekahub-opportunities",

        scanner:
          "installed",

        mode:
          "production-safe",

        cron:
          "every 6 hours",

        time:
          new Date().toISOString()
      });
    }

    if (
      request.method ===
        "GET" &&
      url.pathname ===
        "/supabase-test"
    ) {
      try {
        const rows =
          await supabase(
            env,

            "opportunities?select=id&limit=1",

            {
              method: "GET"
            }
          );

        return json({
          ok: true,

          supabase:
            true,

          message:
            "Supabase connection successful",

          rows_found:
            Array.isArray(rows)
              ? rows.length
              : 0
        });
      } catch (error) {
        return json(
          {
            ok: false,

            supabase:
              false,

            error:
              error.message
          },
          500
        );
      }
    }

    if (
      request.method ===
        "POST" &&
      url.pathname ===
        "/scan"
    ) {
      if (
        !authorized(
          request,
          env
        )
      ) {
        return json(
          {
            ok: false,

            error:
              "Unauthorized. Use Authorization: Bearer <SCAN_TOKEN>."
          },
          401
        );
      }

      try {
        return json(
          await scan(env)
        );
      } catch (error) {
        return json(
          {
            ok: false,

            error:
              error.message
          },
          500
        );
      }
    }

    return new Response(
      "Not found",
      {
        status: 404,

        headers: {
          "Content-Type":
            "text/plain; charset=UTF-8"
        }
      }
    );
  },

  async scheduled(
    controller,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scan(env).catch(
        error => {
          console.error(
            "Scheduled scan failed:",
            error
          );
        }
      )
    );
  }
};
