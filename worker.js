/**
 * IfekaHub Opportunity Scanner - TEST VERSION
 *
 * Required Cloudflare secrets/variables:
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * SCAN_TOKEN
 *
 * New findings are ALWAYS pending, inactive and unpublished.
 * Cron should be configured only after the /health and /scan tests pass.
 */

const SOURCES = [
  ["Jobberman","jobs","https://www.jobberman.com/jobs"],
  ["MyJobMag","jobs","https://www.myjobmag.com/jobs"],
  ["SMEDAN Programmes","grants","https://smedan.gov.ng/our-programs/"],
  ["SMEDAN Conditional Grant Scheme","grants","https://smedan.gov.ng/our-programs/cgs/"],
  ["Federal Scholarship Board","scholarships","https://education.gov.ng/federal-scholarships-board/"],
  ["Federal Scholarship Portal","scholarships","https://scholarship.education.gov.ng/scholarships"],
  ["Bank of Industry","funding","https://www.boi.ng/"],
  ["BOI MSME Support","funding","https://www.boi.ng/who-we-serve/msmes/"],
  ["BOI Intervention Funds","funding","https://www.boi.ng/impact/intervention-funds/"]
];

const LABEL = {
  jobs:"Jobs",
  grants:"Grants & Funding",
  funding:"Grants & Funding",
  scholarships:"Scholarships",
  training:"Training"
};

const BAD = [
  "login","sign in","register","privacy","cookie","terms",
  "contact us","about us","facebook","twitter","instagram",
  "youtube","read more"
];

function clean(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/\s+/g," ")
    .trim();
}

function abs(href,base) {
  try { return new URL(href,base).href; } catch { return ""; }
}

function usefulTitle(t) {
  t=clean(t);
  if(t.length<8 || t.length>180) return false;
  const x=t.toLowerCase();
  return !BAD.some(b => x===b || (x.includes(b) && t.length<28));
}

function category(title,fallback) {
  const t=title.toLowerCase();
  if(/\b(job|jobs|career|careers|vacanc|recruit|employment|hiring)\b/.test(t)) return "jobs";
  if(/\b(scholarship|scholarships|fellowship|fellowships|bursary|studentship)\b/.test(t)) return "scholarships";
  if(/\b(training|bootcamp|workshop|capacity building|course|academy)\b/.test(t)) return "training";
  if(/\b(grant|grants|funding|finance|financing|loan|support scheme|intervention)\b/.test(t)) return "funding";
  return fallback;
}

function deadline(text) {
  const p=[
    /(?:deadline|closing date|application closes?)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(?:deadline|closing date|application closes?)\s*[:\-]?\s*([A-Z][a-z]+ \d{1,2},? \d{4})/i,
    /(?:deadline|closing date|application closes?)\s*[:\-]?\s*(\d{1,2} [A-Z][a-z]+ \d{4})/i
  ];
  for(const r of p) {
    const m=clean(text).match(r);
    if(!m) continue;
    const d=new Date(m[1]);
    if(!Number.isNaN(d.getTime())) return d.toISOString().slice(0,10);
  }
  return null;
}

function links(html,base,source) {
  const out=[],seen=new Set();
  const re=/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))) {
    const title=clean(m[2]), url=abs(m[1],base);
    if(!url || !usefulTitle(title)) continue;
    const key=url.split("#")[0].replace(/\/$/,"").toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    const context=clean(html.slice(Math.max(0,m.index-400),Math.min(html.length,re.lastIndex+700)));
    out.push({
      title,
      url,
      category:category(title,source[1]),
      context
    });
  }
  return out.slice(0,15);
}

async function sb(env,path,options={}) {
  const base=String(env.SUPABASE_URL||"").replace(/\/+$/,"");
  const key=String(env.SUPABASE_SERVICE_ROLE_KEY||"");
  if(!base || !key) throw new Error("Supabase bindings are not configured.");
  const r=await fetch(base+"/rest/v1/"+path,{
    ...options,
    headers:{
      apikey:key,
      Authorization:"Bearer "+key,
      "Content-Type":"application/json",
      Prefer:"return=representation",
      ...(options.headers||{})
    }
  });
  const text=await r.text();
  if(!r.ok) throw new Error("Supabase "+r.status+": "+text.slice(0,500));
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function ensureSources(env) {
  for(const s of SOURCES) {
    try {
      const q=await sb(env,
        "opportunity_sources?select=id&source_url=eq."+encodeURIComponent(s[2])+"&limit=1",
        {method:"GET"});
      if(Array.isArray(q) && q.length) continue;
      await sb(env,"opportunity_sources",{
        method:"POST",
        body:JSON.stringify({
          name:s[0], category:s[1],
          icon:s[1]==="jobs"?"💼":s[1]==="scholarships"?"🎓":s[1]==="training"?"📚":"💰",
          description:"Source monitored by IfekaHub.",
          source_url:s[2], is_active:true
        })
      });
    } catch(e) {
      console.log("Source setup warning:",s[0],e.message);
    }
  }
}

async function duplicate(env,url) {
  const rows=await sb(env,
    "opportunities?select=id,title,application_url&application_url=eq."+encodeURIComponent(url)+"&limit=1",
    {method:"GET"});
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function save(env,source,item) {
  const old=await duplicate(env,item.url);
  if(old) return {action:"duplicate",id:old.id};

  const record={
    title:item.title,
    provider:source[0],
    category:LABEL[item.category] || LABEL[source[1]],
    location:"Nigeria / Online",
    description:item.context.slice(0,1200) || "Opportunity discovered from "+source[0]+".",
    deadline:deadline(item.context),
    application_url:item.url,
    source:source[2],
    featured:false,
    is_active:false,
    approval_status:"pending",
    published:false
  };

  try {
    const rows=await sb(env,"opportunities",{
      method:"POST",
      body:JSON.stringify({...record,status:"Pending"})
    });
    return {
      action:"inserted",
      id:Array.isArray(rows)&&rows[0]?rows[0].id:null,
      title:item.title,
      category:record.category,
      source:source[0],
      deadline:record.deadline
    };
  } catch(e) {
    /* Some older schemas do not have a status column. */
    const rows=await sb(env,"opportunities",{
      method:"POST",
      body:JSON.stringify(record)
    });
    return {
      action:"inserted",
      id:Array.isArray(rows)&&rows[0]?rows[0].id:null,
      title:item.title,
      category:record.category,
      source:source[0],
      deadline:record.deadline
    };
  }
}

async function scan(env) {
  const started=Date.now();
  await ensureSources(env);
  const report={
    ok:true,
    mode:"test",
    started_at:new Date().toISOString(),
    sources:[],
    inserted:[],
    duplicates:0,
    errors:[]
  };

  for(const source of SOURCES) {
    const sr={source:source[0],url:source[2],found:0,inserted:0,duplicates:0,error:null};
    try {
      const r=await fetch(source[2],{
        headers:{
          "User-Agent":"IfekaHub-OpportunityScanner/1.0",
          Accept:"text/html,application/xhtml+xml"
        },
        redirect:"follow"
      });
      if(!r.ok) throw new Error("HTTP "+r.status);
      const html=await r.text();
      const items=links(html,r.url||source[2],source);
      sr.found=items.length;

      for(const item of items) {
        try {
          const result=await save(env,source,item);
          if(result.action==="inserted") {
            sr.inserted++;
            report.inserted.push(result);
          } else {
            sr.duplicates++;
            report.duplicates++;
          }
        } catch(e) {
          report.errors.push({
            source:source[0],
            title:item.title,
            error:e.message
          });
        }
      }
    } catch(e) {
      sr.error=e.message;
      report.errors.push({source:source[0],error:e.message});
    }
    report.sources.push(sr);
  }

  report.duration_ms=Date.now()-started;
  return report;
}

function authorized(request,env) {
  const expected=String(env.SCAN_TOKEN||"").trim();
  const header=request.headers.get("Authorization")||"";
  const supplied=header.startsWith("Bearer ")?header.slice(7).trim():"";
  return !!expected && supplied===expected;
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);

    if(request.method==="GET" && url.pathname==="/") {
      return new Response(
        "IfekaHub Opportunity Scanner installed (TEST mode).",
        {headers:{"Content-Type":"text/plain"}}
      );
    }

    if(request.method==="GET" && url.pathname==="/health") {
      return Response.json({
        ok:true,
        service:"ifekahub-opportunities",
        scanner:"installed",
        mode:"test",
        cron:"every 6 hours after approval",
        time:new Date().toISOString()
      });
        if(request.method==="GET" && url.pathname==="/supabase-test") {
      try {
        const base=String(env.SUPABASE_URL||"").replace(/\/$/,"");
        const key=String(env.SUPABASE_SERVICE_ROLE_KEY||"").trim();

        if(!base || !key) {
          throw new Error("Supabase configuration is missing.");
        }

        const r=await fetch(
          base+"/rest/v1/opportunity_sources?select=id&limit=1",
          {
            headers:{
              "apikey":key,
              "Authorization":"Bearer "+key
            }
          }
        );

        if(!r.ok) {
          throw new Error("Supabase HTTP "+r.status+": "+await r.text());
        }

        const rows=await r.json();

        return Response.json({
          ok:true,
          supabase:true,
          message:"Supabase connection successful",
          rows_found:Array.isArray(rows)?rows.length:0
        });
      } catch(e) {
        return Response.json({
          ok:false,
          supabase:false,
          error:e.message
        },{status:500});
      }
    }
        if(request.method==="POST" && url.pathname==="/scan") {
      if(!authorized(request,env)) {
        return Response.json(
          {ok:false,error:"Unauthorized. Add SCAN_TOKEN and use Authorization: Bearer SCAN_TOKEN."},
          {status:401}
        );
      }

      try {
        return Response.json(await scan(env));
      } catch(e) {
        return Response.json(
          {ok:false,error:e.message},
          {status:500}
        );
      }
    }

    return new Response("Not found",{status:404});
  },

  async scheduled(controller,env,ctx) {
  ctx.waitUntil(
    (async()=>{
      try {
        const report=await scan(env);
        console.log("SCAN_REPORT",JSON.stringify(report));
      } catch(e) {
        console.error("Scheduled scan failed:",e);
      }
    })()
  );
}
  ctx.waitUntil(
    (async()=>{
      try {
        const report=await scan(env);
        console.log("SCAN_REPORT",JSON.stringify(report));
      } catch(e) {
        console.error("Scheduled scan failed:",e);
      }
    })()
  )
}
}
