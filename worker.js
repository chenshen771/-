export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return json({
        ok: true,
        service: 'gushi',
        hasDb: !!env.DB,
        hasKey: !!env.FINNHUB_API_KEY,
        hasAppSecret: !!env.APP_SECRET,
        hasAI: !!env.AI,
        hasGemini: !!env.GEMINI_API_KEY,
        hasDeepseek: !!env.DEEPSEEK_API_KEY,
        hasOpenAI: !!env.OPENAI_API_KEY,
        hasBrowse: !!env.browse,
      });
    }

    if (path === '/webhook/finnhub' && request.method === 'POST') {
      try {
        if (!env.DB) return json({ ok: false, error: 'DB not bound' }, 500);
        const body = await request.text();
        await env.DB.prepare(
          'INSERT INTO webhook_events (source, payload, created_at) VALUES (?, ?, ?)'
        )
          .bind('finnhub', body, new Date().toISOString())
          .run();
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (path === '/api/quote' && request.method === 'GET') {
      const symbol = url.searchParams.get('symbol') || 'AAPL';
      const token = env.FINNHUB_API_KEY;
      if (!token) return json({ error: 'FINNHUB_API_KEY not set' }, 500);
      try {
        const api =
          'https://finnhub.io/api/v1/quote?symbol=' +
          encodeURIComponent(symbol) +
          '&token=' +
          token;
        const r = await fetch(api);
        const data = await r.text();
        return new Response(data, {
          status: r.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=5',
          },
        });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const apiResp = await handleApi(request, env, url);
    if (apiResp) return apiResp;

    const target = url.searchParams.get('url');
    if (!target) {
      if (path === '/' || path === '') {
        return json({
          ok: true,
          service: 'gushi',
          usage: {
            health: '/health',
            proxy: '?url=https://...',
            quote: '/api/quote?symbol=AAPL',
            bars: 'GET/POST /api/bars',
            predictions: '/api/predictions',
            positions: '/api/positions',
            ai: 'POST /api/ai/run',
            browse: 'POST /api/browse',
            cache: 'GET/POST /api/cache · POST /api/cache/purge',
            webhook: 'POST /webhook/finnhub',
          },
        });
      }
      return json(
        {
          error: 'missing url param',
          example:
            '?url=https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d',
        },
        400
      );
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: 'invalid url' }, 400);
    }

    const allow = [
      'query1.finance.yahoo.com',
      'query2.finance.yahoo.com',
      'push2delay.eastmoney.com',
      'push2.eastmoney.com',
      'np-listapi.eastmoney.com',
      'finnhub.io',
    ];
    if (
      !allow.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
      )
    ) {
      return json({ error: 'domain not allowed: ' + parsed.hostname }, 403);
    }

    try {
      const res = await fetch(target, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
        },
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type':
            res.headers.get('Content-Type') ||
            'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=30',
        },
      });
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};

function json(obj, status) {
  status = status || 200;
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function checkAuth(request, env) {
  const key = request.headers.get('X-App-Key');
  return !!(env.APP_SECRET && key && key === env.APP_SECRET);
}

async function handleApi(request, env, url) {
  if (url.pathname === '/api/bars/upsert' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const body = await request.json();
      if (!body.symbol || !Array.isArray(body.bars)) {
        return json({ error: 'need symbol and bars[]' }, 400);
      }
      const stmt = env.DB.prepare(
        'INSERT INTO daily_bars (symbol,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?) ON CONFLICT(symbol,date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume'
      );
      const batch = body.bars.map(function (b) {
        return stmt.bind(
          body.symbol,
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume || 0
        );
      });
      await env.DB.batch(batch);
      return json({ ok: true, count: batch.length });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/bars' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return json({ error: 'missing symbol' }, 400);
    const from = url.searchParams.get('from') || '2000-01-01';
    const to = url.searchParams.get('to') || '2100-01-01';
    try {
      const res = await env.DB.prepare(
        'SELECT date,open,high,low,close,volume FROM daily_bars WHERE symbol=? AND date BETWEEN ? AND ? ORDER BY date ASC'
      )
        .bind(symbol, from, to)
        .all();
      return json({ symbol: symbol, bars: res.results || [] });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      const id = b.id || crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO prediction_log (id,symbol,mode,predicted_at,price_at_predict,p_up,p_down,target_high,target_low,horizon_days) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
        .bind(
          id,
          b.symbol,
          b.mode || 'backtest',
          b.predicted_at || new Date().toISOString(),
          b.price_at_predict,
          b.p_up,
          b.p_down,
          b.target_high,
          b.target_low,
          b.horizon_days || 1
        )
        .run();
      return json({ ok: true, id: id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions/resolve' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      const res = await env.DB.prepare(
        'SELECT price_at_predict FROM prediction_log WHERE id=?'
      )
        .bind(b.id)
        .all();
      if (!res.results || !res.results.length) {
        return json({ error: 'not found' }, 404);
      }
      const before = res.results[0].price_at_predict;
      var result = 'flat';
      if (b.actual_price > before) result = 'up';
      else if (b.actual_price < before) result = 'down';
      await env.DB.prepare(
        'UPDATE prediction_log SET actual_price=?, actual_result=?, resolved_at=? WHERE id=?'
      )
        .bind(b.actual_price, result, new Date().toISOString(), b.id)
        .run();
      return json({ ok: true, result: result });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/predictions/winrate' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const days = Number(url.searchParams.get('days') || 30);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const res = await env.DB.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN (p_up>=50 AND actual_result='up') OR (p_up<50 AND actual_result='down') THEN 1 ELSE 0 END) AS correct FROM prediction_log WHERE resolved_at IS NOT NULL AND predicted_at >= ?"
      )
        .bind(since)
        .all();
      const row = (res.results && res.results[0]) || { total: 0, correct: 0 };
      const winRate = row.total ? row.correct / row.total : null;
      return json({ total: row.total, correct: row.correct, winRate: winRate });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const status = url.searchParams.get('status');
      const symbol = url.searchParams.get('symbol');
      var sql = 'SELECT * FROM positions WHERE 1=1';
      var binds = [];
      if (status && status !== 'all') {
        sql += ' AND status=?';
        binds.push(status);
      }
      if (symbol) {
        sql += ' AND symbol=?';
        binds.push(symbol);
      }
      sql += ' ORDER BY buy_at DESC';
      var stmt = env.DB.prepare(sql);
      var res2;
      if (binds.length) res2 = await stmt.bind.apply(stmt, binds).all();
      else res2 = await stmt.all();
      return json({ positions: res2.results || [] });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.symbol || b.qty == null || b.buy_price == null) {
        return json({ error: 'need symbol, qty, buy_price' }, 400);
      }
      const id = b.id || crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        'INSERT INTO positions (id,symbol,market,side,qty,buy_price,buy_at,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
      )
        .bind(
          id,
          b.symbol,
          b.market || 'us',
          b.side || 'long',
          b.qty,
          b.buy_price,
          b.buy_at || now,
          'open',
          b.note || null,
          now,
          now
        )
        .run();
      return json({ ok: true, id: id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions/close' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.id || b.sell_price == null) {
        return json({ error: 'need id, sell_price' }, 400);
      }
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE positions SET sell_price=?, sell_at=?, status='closed', updated_at=? WHERE id=?"
      )
        .bind(b.sell_price, b.sell_at || now, now, b.id)
        .run();
      return json({ ok: true, id: b.id });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/positions/delete' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b.id) return json({ error: 'need id' }, 400);
      await env.DB.prepare('DELETE FROM positions WHERE id=?').bind(b.id).run();
      return json({ ok: true });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/ai/run' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    try {
      const b = await request.json();
      const provider = String(b.provider || 'workers-ai').toLowerCase();
      const messages = b.messages || [
        { role: 'user', content: b.title || b.prompt || '' },
      ];

      if (provider === 'workers-ai') {
        if (!env.AI) return json({ error: 'AI not bound' }, 500);
        const model = b.model || '@cf/meta/llama-3.2-3b-instruct';
        const result = await env.AI.run(model, { messages: messages });
        return json({
          provider: provider,
          model: model,
          text: (result && (result.response || result.text)) || '',
          raw: result,
        });
      }

      if (provider === 'gemini') {
        if (!env.GEMINI_API_KEY) {
          return json({ error: 'GEMINI_API_KEY not set' }, 500);
        }
        const model = b.model || 'gemini-2.0-flash';
        const contents = messages.map(function (m) {
          return {
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          };
        });
        const api =
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model) +
          ':generateContent?key=' +
          encodeURIComponent(env.GEMINI_API_KEY);
        const r = await fetch(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: contents }),
        });
        const data = await r.json();
        var out = '';
        try {
          const c0 = (data.candidates || [])[0] || {};
          const parts = (c0.content && c0.content.parts) || [];
          out = parts
            .map(function (p) {
              return p.text || '';
            })
            .join('');
        } catch (e2) {}
        return json({
          provider: provider,
          model: model,
          text: out,
          raw: data,
          status: r.status,
        });
      }

      if (provider === 'deepseek') {
        if (!env.DEEPSEEK_API_KEY) {
          return json({ error: 'DEEPSEEK_API_KEY not set' }, 500);
        }
        const model = b.model || 'deepseek-chat';
        const r = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
          },
          body: JSON.stringify({ model: model, messages: messages }),
        });
        const data = await r.json();
        var out2 = '';
        try {
          out2 =
            (((data.choices || [])[0] || {}).message || {}).content || '';
        } catch (e3) {}
        return json({
          provider: provider,
          model: model,
          text: out2,
          raw: data,
          status: r.status,
        });
      }

      if (provider === 'openai') {
        if (!env.OPENAI_API_KEY) {
          return json({ error: 'OPENAI_API_KEY not set' }, 500);
        }
        const model = b.model || 'gpt-4o-mini';
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + env.OPENAI_API_KEY,
          },
          body: JSON.stringify({ model: model, messages: messages }),
        });
        const data = await r.json();
        var out3 = '';
        try {
          out3 =
            (((data.choices || [])[0] || {}).message || {}).content || '';
        } catch (e4) {}
        return json({
          provider: provider,
          model: model,
          text: out3,
          raw: data,
          status: r.status,
        });
      }

      return json({ error: 'unknown provider: ' + provider }, 400);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/news/judge' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.AI) return json({ error: 'AI not bound' }, 500);
    try {
      const b = await request.json();
      const result = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          {
            role: 'system',
            content:
              '你是判断股票新闻标题对股价影响的助手。只用这个格式回答，不要多余文字：方向|程度\n方向只能是 利好/利空/中性 三选一，程度是1到10的整数。例如：利空|7',
          },
          { role: 'user', content: b.title || '' },
        ],
      });
      const raw = ((result && result.response) || '').trim();
      const parts = raw.split('|');
      return json({
        title: b.title,
        direction: (parts[0] || '中性').trim(),
        score: Number(parts[1]) || 0,
        raw: raw,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }


  // ---- 通用云端缓存（打开网页时读写；关网页不跑）----
  if (url.pathname === '/api/cache' && request.method === 'GET') {
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    const key = url.searchParams.get('key');
    if (!key) return json({ error: 'missing key' }, 400);
    try {
      const res = await env.DB.prepare(
        'SELECT key, value, updated_at, expires_at FROM cache_kv WHERE key = ?'
      )
        .bind(key)
        .all();
      const row = res.results && res.results[0];
      if (!row) return json({ ok: true, found: false, key: key });
      if (row.expires_at) {
        const exp = Date.parse(row.expires_at);
        if (!isNaN(exp) && exp < Date.now()) {
          try {
            await env.DB.prepare('DELETE FROM cache_kv WHERE key = ?').bind(key).run();
          } catch (eDel) {}
          return json({ ok: true, found: false, key: key, expired: true });
        }
      }
      var data = null;
      try {
        data = JSON.parse(row.value);
      } catch (eParse) {
        data = row.value;
      }
      return json({
        ok: true,
        found: true,
        key: row.key,
        data: data,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/cache' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = await request.json();
      if (!b || !b.key) return json({ error: 'need key' }, 400);
      const now = new Date().toISOString();
      var expires = null;
      const ttlDays = Number(b.ttlDays);
      if (ttlDays > 0) {
        expires = new Date(Date.now() + ttlDays * 86400000).toISOString();
      } else if (b.expires_at) {
        expires = String(b.expires_at);
      }
      const value =
        typeof b.data === 'string' ? b.data : JSON.stringify(b.data == null ? null : b.data);
      if (value.length > 900000) {
        return json({ error: 'payload too large' }, 413);
      }
      await env.DB.prepare(
        'INSERT INTO cache_kv (key, value, updated_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, expires_at=excluded.expires_at'
      )
        .bind(b.key, value, now, expires)
        .run();
      // 顺手清理同前缀过期项（可选 prefix）
      if (b.purgePrefix) {
        try {
          await env.DB.prepare(
            "DELETE FROM cache_kv WHERE key LIKE ? AND expires_at IS NOT NULL AND expires_at < ?"
          )
            .bind(String(b.purgePrefix) + '%', now)
            .run();
        } catch (eP) {}
      }
      return json({ ok: true, key: b.key, updated_at: now, expires_at: expires });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/cache/purge' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    if (!env.DB) return json({ error: 'DB not bound' }, 500);
    try {
      const b = (await request.json().catch(function () { return {}; })) || {};
      const now = new Date().toISOString();
      var deleted = 0;
      // 1) 删已过期
      const r1 = await env.DB.prepare(
        'DELETE FROM cache_kv WHERE expires_at IS NOT NULL AND expires_at < ?'
      )
        .bind(now)
        .run();
      deleted += (r1 && r1.meta && r1.meta.changes) || 0;
      // 2) 按前缀 + 最大保留天数（updated_at 过旧）
      const maxAgeDays = Number(b.maxAgeDays);
      if (b.prefix && maxAgeDays > 0) {
        const cut = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
        const r2 = await env.DB.prepare(
          'DELETE FROM cache_kv WHERE key LIKE ? AND updated_at < ?'
        )
          .bind(String(b.prefix) + '%', cut)
          .run();
        deleted += (r2 && r2.meta && r2.meta.changes) || 0;
      }
      return json({ ok: true, deleted: deleted });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  if (url.pathname === '/api/browse' && request.method === 'POST') {
    if (!checkAuth(request, env)) return json({ error: 'forbidden' }, 403);
    try {
      const b = await request.json();
      if (!b.url) return json({ error: 'missing url' }, 400);
      var targetUrl;
      try {
        targetUrl = new URL(b.url);
      } catch (e5) {
        return json({ error: 'invalid url' }, 400);
      }
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return json({ error: 'only http/https' }, 400);
      }
      const r = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      var body = await r.text();
      const max = 200000;
      if (body.length > max) body = body.slice(0, max);
      if ((b.mode || 'text') === 'text') {
        body = body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50000);
      }
      return json({
        ok: true,
        status: r.status,
        url: targetUrl.toString(),
        mode: b.mode || 'text',
        content: body,
        note: '简易抓取；需 JS 渲染的页面以后可用 Puppeteer 增强',
      });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  }

  return null;
}
