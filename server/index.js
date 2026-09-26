import express from 'express'
import { db, parseTimeMs } from './db.js'

const app = express()
app.use(express.json())

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)
const now = () => new Date().toLocaleString('zh-CN')

// 高等级预警（红/橙）触发时自动建档危机事件
const AUTO_LEVELS = ['red', 'orange']
const LV_TEXT = { red: '红色', orange: '橙色', yellow: '黄色' }

// 危机列表（含来源规则、承接规则、未解除预警数、时间线）
function crisisList(withTimeline = false) {
  const list = q(`SELECT c.*, a.title alert_title,
    (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=c.id AND ae.status='open') open_events
    FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id ORDER BY c.id DESC`)
  return list.map((c) => {
    const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at, al.title alert_title, al.level alert_level
      FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
      WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
    const item = { ...c, rules }
    if (withTimeline) item.timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
    return item
  })
}

// 承接某事件的规则关联（无则插入），刷新最近触发时间
function attachRule(crisisId, alertId, isOrigin, timeStr) {
  const exists = q1('SELECT 1 FROM crisis_alerts WHERE crisis_id=? AND alert_id=?', crisisId, alertId)
  if (exists) run('UPDATE crisis_alerts SET last_at=?, is_origin=MAX(is_origin,?) WHERE crisis_id=? AND alert_id=?', timeStr, isOrigin ? 1 : 0, crisisId, alertId)
  else run('INSERT INTO crisis_alerts (crisis_id,alert_id,is_origin,first_at,last_at) VALUES (?,?,?,?,?)', crisisId, alertId, isOrigin ? 1 : 0, timeStr, timeStr)
}

// 简易情感打分（演示用，规则匹配）
const NEG = ['慢', '卫生', '投诉', '延期', '质疑', '故障', '涨价', '维权', '不满', '告', '退款', '坑', '吐槽', '回应迟']
const POS = ['好评', '回升', '利好', '积极', '满意', '点赞', '惠民', '提升', '突破', '肯定', '有效']
function analyze(text) {
  let score = 0
  NEG.forEach((w) => { if (text.includes(w)) score -= 0.5 })
  POS.forEach((w) => { if (text.includes(w)) score += 0.5 })
  score = Math.max(-1, Math.min(1, score))
  return { sentiment: score < -0.2 ? 'negative' : score > 0.2 ? 'positive' : 'neutral', score }
}

// 总览统计（单条/批量录入后统一刷新）
function statsSummary(posts = q('SELECT * FROM posts')) {
  const total = posts.length
  const pos = posts.filter((p) => p.sentiment === 'positive').length
  const neg = posts.filter((p) => p.sentiment === 'negative').length
  return {
    total, pos, neg, neu: total - pos - neg,
    negRate: total ? Math.round((neg / total) * 100) : 0,
    hot: posts.filter((p) => p.hot).length,
    topHeat: Math.max(...posts.map((p) => p.heat), 0)
  }
}

// ===== 总览 =====
app.get('/api/state', (req, res) => {
  const posts = q('SELECT * FROM posts')
  const hot = q('SELECT * FROM hot_words ORDER BY weight DESC LIMIT 12')
  const activeAlerts = q('SELECT * FROM alerts WHERE active=1')
  const crises = crisisList()
  const sources = q('SELECT s.*, COUNT(p.id) cnt FROM sources s LEFT JOIN posts p ON p.source_id=s.id GROUP BY s.id')
  // 热度趋势（近7时段）
  const nowH = new Date().getHours()
  const trend = []
  for (let i = 6; i >= 0; i--) {
    const seg = nowH - i
    const label = (seg + 24) % 24
    const len = posts.length
    const v = Math.round((len * (0.55 + ((i % 3) * 0.15))) + (Math.sin(i * 1.7) * 6))
    trend.push({ label, value: Math.max(18, v) })
  }
  res.json({
    sources, hotWords: hot, activeAlerts, crises,
    stats: statsSummary(posts),
    trend
  })
})

// ===== 舆情列表（支持筛选） =====
app.get('/api/posts', (req, res) => {
  const { sentiment, source, topic, q: kw } = req.query
  let sql = 'SELECT * FROM posts WHERE 1=1'
  const args = []
  if (sentiment && sentiment !== 'all') { args.push(sentiment); sql += ` AND sentiment=?` }
  if (source && source !== 'all') { args.push(+source); sql += ` AND source_id=?` }
  if (topic) { args.push(topic); sql += ` AND topic LIKE ?`; args.push(`%${topic}%`) }
  if (kw) { args.push(`%${kw}%`); args.push(`%${kw}%`); sql += ` AND (title LIKE ? OR content LIKE ?)` }
  sql += ' ORDER BY published DESC'
  res.json(q(sql, ...args))
})
app.get('/api/topics', (req, res) => {
  res.json(db.prepare('SELECT DISTINCT topic FROM posts').all().map((r) => r.topic))
})

// 录入校验：标题/正文必填（批量导入时按条定位错误）
function validateItem(it, idx) {
  const errs = []
  if (!it || typeof it !== 'object') errs.push('格式错误')
  else {
    if (typeof it.title !== 'string' || !it.title.trim()) errs.push('缺少标题')
    if (typeof it.content !== 'string' || !it.content.trim()) errs.push('缺少正文')
  }
  return errs.length ? `第${idx + 1}条：${errs.join('、')}` : null
}

// 统一录入管线：逐条情感分析 → 落库 → 预警检查（红/橙级自动建档危机或去重并入）
function ingestPost(item) {
  const title = (item.title || '').trim()
  const content = (item.content || '').trim()
  const text = title + ' ' + content
  const a = analyze(text)
  // 热度与负面关键词命中数挂钩，便于稳定演示预警触发
  const negHits = NEG.filter((w) => text.includes(w)).length
  const heat = Math.min(100, 35 + negHits * 12 + Math.round(Math.random() * 12) + (a.sentiment === 'negative' ? 8 : 0))
  const r = run('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    title, content, item.source_id || 1, a.sentiment, a.score, heat,
    a.sentiment === 'negative' ? 1 : 0, (item.topic || '').trim() || '新增', (item.media || '').trim(), now(), now())
  const id = Number(r.lastInsertRowid)
  const triggered = checkAlerts(id)
  return { id, title, sentiment: a.sentiment, score: a.score, heat, triggered }
}

// 新增舆情（单条录入，走统一管线，响应结构保持不变）
app.post('/api/posts', (req, res) => {
  const err = validateItem(req.body, 0)
  if (err) return res.status(400).json({ error: err })
  const r = ingestPost(req.body)
  res.json({ ok: true, id: r.id, sentiment: r.sentiment, heat: r.heat, triggered: r.triggered })
})

// 批量导入：整批预校验 → 事务内逐条分析落库（预警/危机闭环与单条一致），任一失败整体回滚
const BATCH_MAX = 200
app.post('/api/posts/batch', (req, res) => {
  const items = req.body && req.body.items
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > BATCH_MAX) return res.status(400).json({ error: `单次最多导入 ${BATCH_MAX} 条` })
  // 先整批校验，任一不合格直接拒绝（尚未写库，无需回滚）
  const errors = items.map((it, i) => validateItem(it, i)).filter(Boolean)
  if (errors.length) return res.status(400).json({ error: '校验失败，未导入任何数据', details: errors })

  db.exec('BEGIN')
  let results
  try {
    results = items.map((it) => ingestPost(it))
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已提交或已回滚 */ }
    return res.status(500).json({ error: `导入失败，已整体回滚：${e.message}` })
  }
  const fired = results.flatMap((r) => r.triggered)
  res.json({
    ok: true,
    imported: results.length,
    results,
    summary: {
      alerts: fired.length,
      crisesCreated: fired.filter((t) => t.crisisId && !t.deduped).length,
      crisesMerged: fired.filter((t) => t.deduped).length
    },
    stats: statsSummary() // 统计刷新
  })
})

function checkAlerts(postId) {
  const p = q1('SELECT * FROM posts WHERE id=?', postId)
  const alerts = q('SELECT * FROM alerts WHERE active=1')
  const fired = []
  for (const al of alerts) {
    const kwHit = !al.keyword || (p.title + p.content).includes(al.keyword)
    const sentHit = !al.sentiment || p.sentiment === al.sentiment
    const heatHit = p.heat >= al.heat_min
    if (!(kwHit && sentHit && heatHit)) continue
    run('UPDATE alerts SET trigger_count=trigger_count+1 WHERE id=?', al.id)
    const detail = `命中关键词「${al.keyword || '全部'}」· ${al.sentiment ? '情感：' + al.sentiment : '不限情感'} · 热度${p.heat}`
    const ts = now()
    const tsMs = Date.now()
    // 归并话题：规则指定则以规则为准，否则以命中舆情的话题为准
    const topic = (al.merge_topic || p.topic || '').trim()
    // 闭环：高等级预警 → 危机事件。按「同话题 + 时间窗口内 + 未结案」归并；
    // 同一规则下不同话题/超出窗口分别建档；新规则并入既有同话题事件（承接多规则）。
    let crisisId = null, deduped = false
    if (AUTO_LEVELS.includes(al.level) && topic) {
      const winMs = (al.merge_window > 0 ? al.merge_window : 0) * 60000
      let open = null
      const cands = q("SELECT * FROM crisis WHERE topic=? AND status!='closed' ORDER BY last_trigger_at DESC, id DESC", topic)
      for (const c of cands) {
        const lastMs = c.last_trigger_at == null ? parseTimeMs(c.updated) : c.last_trigger_at
        if (!winMs || (lastMs != null && tsMs - lastMs <= winMs)) { open = c; break }
      }
      if (open) {
        crisisId = open.id
        deduped = true
        run('UPDATE crisis SET updated=?, last_trigger_at=? WHERE id=?', ts, tsMs, open.id)
        // 该规则是否已承接此事件：决定时间线语义
        const linked = q1('SELECT 1 FROM crisis_alerts WHERE crisis_id=? AND alert_id=?', open.id, al.id)
        attachRule(open.id, al.id, false, ts)
        run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
          open.id, linked ? '预警再次触发' : '规则归并',
          linked
            ? `${detail} · 关联舆情《${p.title}》`
            : `承接规则「${al.title}」（${LV_TEXT[al.level]}）：${detail} · 关联舆情《${p.title}》`, ts)
      } else {
        const r = run('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          al.title, al.level, 'monitoring', '',
          `由${LV_TEXT[al.level]}预警「${al.title}」自动建档：话题「${topic}」，命中关键词「${al.keyword || '全部'}」，首条关联舆情《${p.title}》（热度${p.heat}）。`,
          ts, ts, '', al.keyword, al.id, 'auto', topic, tsMs)
        crisisId = Number(r.lastInsertRowid)
        attachRule(crisisId, al.id, true, ts)
        run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
          crisisId, '自动建档', `高等级预警触发：${detail}`, ts)
      }
    }
    const ev = run('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved) VALUES (?,?,?,?,?,?,?)',
      al.id, postId, crisisId, detail, ts, 'open', null)
    fired.push({ alert: al.title, level: al.level, eventId: Number(ev.lastInsertRowid), crisisId, deduped, topic })
  }
  return fired
}

// ===== 热门词 =====
app.post('/api/hotwords', (req, res) => {
  const { word, weight, sentiment = 'neutral' } = req.body
  run('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)', word, weight, sentiment)
  res.json({ ok: true })
})
app.delete('/api/hotwords/:id', (req, res) => {
  run('DELETE FROM hot_words WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ===== 预警 =====
app.get('/api/alerts', (req, res) => {
  res.json({
    alerts: q('SELECT * FROM alerts ORDER BY id DESC'),
    events: q(`SELECT ae.*, p.title pt, p.heat heat, p.sentiment sent, c.title crisis_title
      FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN crisis c ON c.id=ae.crisis_id
      ORDER BY ae.id DESC LIMIT 60`)
  })
})
app.post('/api/alerts', (req, res) => {
  const { title, level, keyword, sentiment, heat_min, merge_topic, merge_window } = req.body
  run('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count,merge_topic,merge_window) VALUES (?,?,?,?,?,1,?,0,?,?)',
    title, level, keyword || '', sentiment || '', heat_min || 0, now(), (merge_topic || '').trim(), Math.max(0, +merge_window || 0))
  res.json({ ok: true })
})
app.post('/api/alerts/:id/toggle', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  run('UPDATE alerts SET active=? WHERE id=?', al.active ? 0 : 1, al.id)
  res.json({ ok: true, active: al.active ? 0 : 1 })
})
app.delete('/api/alerts/:id', (req, res) => {
  // 保留 alert_events 触发记录（危机回溯/历史时间线的一部分），仅解除事件↔规则关联
  run('DELETE FROM crisis_alerts WHERE alert_id=?', req.params.id)
  run('DELETE FROM alerts WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 解除单条触发记录：同步危机时间线，返回该危机剩余未解除数
app.post('/api/alert-events/:id/resolve', (req, res) => {
  const ev = q1('SELECT * FROM alert_events WHERE id=?', req.params.id)
  if (!ev) return res.status(404).json({ error: 'not found' })
  if (ev.status === 'resolved') return res.json({ ok: true, already: true, crisisId: ev.crisis_id })
  const note = (req.body.note || '').trim() || '风险指标回落，预警解除'
  run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
  let openLeft = 0
  if (ev.crisis_id) {
    const c = q1('SELECT * FROM crisis WHERE id=?', ev.crisis_id)
    if (c && c.status !== 'closed') {
      const al = q1('SELECT title FROM alerts WHERE id=?', ev.alert_id)
      const noteFull = al ? `规则「${al.title}」：${note}` : note
      run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, '预警解除', noteFull, now())
      run('UPDATE crisis SET updated=? WHERE id=?', now(), c.id)
    }
    openLeft = q1("SELECT COUNT(*) c FROM alert_events WHERE crisis_id=? AND status='open'", ev.crisis_id).c
  }
  res.json({ ok: true, crisisId: ev.crisis_id, openLeft })
})

// 批量解除某规则全部未解除触发（按危机合并写入时间线）
app.post('/api/alerts/:id/resolve', (req, res) => {
  const al = q1('SELECT * FROM alerts WHERE id=?', req.params.id)
  if (!al) return res.status(404).json({ error: 'not found' })
  const events = q("SELECT * FROM alert_events WHERE alert_id=? AND status='open'", al.id)
  const note = (req.body.note || '').trim() || '风险指标回落，批量解除'
  const byCrisis = {}
  for (const ev of events) {
    run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
    if (ev.crisis_id) (byCrisis[ev.crisis_id] ||= []).push(ev)
  }
  for (const [cid, evs] of Object.entries(byCrisis)) {
    const c = q1('SELECT * FROM crisis WHERE id=?', cid)
    if (c && c.status !== 'closed') {
      run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)',
        c.id, '预警解除', `规则「${al.title}」：${note}（一并解除 ${evs.length} 条触发记录）`, now())
      run('UPDATE crisis SET updated=? WHERE id=?', now(), c.id)
    }
  }
  res.json({ ok: true, resolved: events.length })
})

// ===== 危机处置 =====
app.get('/api/crisis', (req, res) => {
  res.json(crisisList(true))
})
app.post('/api/crisis', (req, res) => {
  const { title, level, keyword, topic, plan, analysis, linked_email } = req.body
  const r = run("INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,origin,topic,last_trigger_at) VALUES (?,?,?,?,?,?,?,?,?,'manual',?,NULL)",
    title, level || 'orange', 'monitoring', plan || '', analysis || '', now(), now(), linked_email || '', keyword || '', (topic || '').trim())
  const id = Number(r.lastInsertRowid)
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', id, '事件建档', '人工建档，初始响应', now())
  res.json({ ok: true, id })
})
app.post('/api/crisis/:id/status', (req, res) => {
  const { status, action, note } = req.body
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  run('UPDATE crisis SET status=?, updated=? WHERE id=?', status || c.status, now(), c.id)
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, action || '状态更新', note || '', now())
  res.json({ ok: true })
})
app.post('/api/crisis/:id/timeline', (req, res) => {
  const { action, note } = req.body
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', req.params.id, action, note || '', now())
  run('UPDATE crisis SET updated=? WHERE id=?', now(), req.params.id)
  res.json({ ok: true })
})

// 回溯：危机档案 + 承接规则 + 关联预警触发记录（按规则拆分）+ 统计
app.get('/api/crisis/:id/review', (req, res) => {
  const c = q1('SELECT c.*, a.title alert_title FROM crisis c LEFT JOIN alerts a ON a.id=c.alert_id WHERE c.id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  const timeline = q('SELECT * FROM crisis_timeline WHERE crisis_id=? ORDER BY id DESC', c.id)
  const events = q(`SELECT ae.*, p.title pt, p.heat, p.sentiment sent, a.title alert_title, a.level alert_level
    FROM alert_events ae LEFT JOIN posts p ON p.id=ae.post_id LEFT JOIN alerts a ON a.id=ae.alert_id
    WHERE ae.crisis_id=? ORDER BY ae.id DESC`, c.id)
  const open = events.filter((e) => e.status === 'open').length
  // 按规则拆分触发统计（同一事件承接多条规则时分别统计）
  const rules = q(`SELECT ca.alert_id, ca.is_origin, ca.first_at, ca.last_at,
      al.title alert_title, al.level alert_level,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id) triggers,
      (SELECT COUNT(*) FROM alert_events ae WHERE ae.crisis_id=ca.crisis_id AND ae.alert_id=ca.alert_id AND ae.status='open') open
    FROM crisis_alerts ca LEFT JOIN alerts al ON al.id=ca.alert_id
    WHERE ca.crisis_id=? ORDER BY ca.is_origin DESC, ca.alert_id`, c.id)
  res.json({
    crisis: c, timeline, events, rules,
    stats: {
      triggers: events.length,
      open,
      resolved: events.length - open,
      rules: rules.length,
      posts: new Set(events.map((e) => e.post_id).filter((x) => x != null)).size,
      firstAt: events.length ? events[events.length - 1].time : null,
      lastAt: events.length ? events[0].time : null
    }
  })
})

// 结案：写入回溯总结，级联解除关联的未解除预警，完成闭环
app.post('/api/crisis/:id/close', (req, res) => {
  const c = q1('SELECT * FROM crisis WHERE id=?', req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  if (c.status === 'closed') return res.json({ ok: true, already: true })
  const summary = (req.body.summary || '').trim() || '预警解除，舆情回落，完成处置闭环。'
  const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", c.id)
  for (const ev of opens) run("UPDATE alert_events SET status='resolved', resolved=? WHERE id=?", now(), ev.id)
  run("UPDATE crisis SET status='closed', updated=? WHERE id=?", now(), c.id)
  // 结案级联解除可能横跨多条规则，记录涉及的规则名
  const auto = opens.length
    ? `（同步解除 ${opens.length} 条未解除预警：${[...new Set(opens.map((e) => e.alert_id))].map((rid) => {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid); return al ? `「${al.title}」` : '已删除规则'
      }).join('、')}）`
    : ''
  run('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)', c.id, '事件结案', summary + auto, now())
  res.json({ ok: true, resolved: opens.length })
})
app.delete('/api/crisis/:id', (req, res) => {
  run('DELETE FROM crisis_alerts WHERE crisis_id=?', req.params.id)
  run('UPDATE alert_events SET crisis_id=NULL WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis_timeline WHERE crisis_id=?', req.params.id)
  run('DELETE FROM crisis WHERE id=?', req.params.id)
  res.json({ ok: true })
})

const PORT = 4130
app.listen(PORT, () => console.log(`[PUBMON] API running at http://localhost:${PORT}`))