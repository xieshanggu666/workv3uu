// 迁移测试：构造旧结构库文件（crisis.alert_id 一对一、无 crisis_alerts 表），
// 启动服务器验证旧关联迁移到多对多关系且历史时间线保留
// 运行：node test/migration.mjs
import { spawn } from 'node:child_process'
import initSqlJs from 'sql.js'
import fs from 'node:fs'

const DB_FILE = '/tmp/pubmon-old.db'
const BASE = 'http://localhost:4130'
let pass = 0, fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✘ ${name} ${extra}`) }
}
const api = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  return r.json()
}

// 1. 构造旧库（无 merge_topic/merge_window/topic 列，无 crisis_alerts 表）
const SQL = await initSqlJs({ locateFile: (f) => `node_modules/sql.js/dist/${f}` })
const db = new SQL.Database()
const now = new Date().toLocaleString('zh-CN')
db.exec(`
CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT INTO sources VALUES (1,'微博');
CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL,
  source_id INTEGER NOT NULL, sentiment TEXT NOT NULL, sentiment_score REAL NOT NULL, heat INTEGER NOT NULL,
  hot INTEGER NOT NULL DEFAULT 0, topic TEXT NOT NULL, media TEXT NOT NULL DEFAULT '', published TEXT NOT NULL, created TEXT NOT NULL);
INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created)
  VALUES ('旧投诉舆情','发货慢引投诉',1,'negative',-0.6,82,1,'电商物流','', '${now}', '${now}');
CREATE TABLE hot_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL, weight INTEGER NOT NULL, sentiment TEXT NOT NULL DEFAULT 'neutral');
CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, level TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '', sentiment TEXT NOT NULL DEFAULT '', heat_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, trigger_count INTEGER NOT NULL DEFAULT 0);
INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count)
  VALUES ('投诉类话题升温','orange','投诉','negative',65,1,'${now}',1);
CREATE TABLE alert_events (id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER NOT NULL, post_id INTEGER,
  crisis_id INTEGER, detail TEXT NOT NULL, time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved TEXT);
INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved)
  VALUES (1,1,1,'命中关键词「投诉」· 情感：negative · 热度82','${now}','open',NULL);
CREATE TABLE crisis (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, level TEXT NOT NULL,
  status TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '', analysis TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, updated TEXT NOT NULL, linked_email TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '', alert_id INTEGER, origin TEXT NOT NULL DEFAULT 'manual');
INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin)
  VALUES ('旧危机事件','orange','monitoring','','旧库遗留事件','${now}','${now}','','投诉',1,'auto');
CREATE TABLE crisis_timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, crisis_id INTEGER NOT NULL,
  action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', time TEXT NOT NULL);
INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES
  (1,'自动建档','历史：高等级预警触发','${now}'),
  (1,'处置跟进','历史：已发布回应','${now}');
`)
fs.writeFileSync(DB_FILE, Buffer.from(db.export()))
db.close()

// 2. 启动服务器（加载旧库，触发迁移）
const server = spawn('node', ['--no-warnings', '--loader', './test/shim-loader.mjs', 'server/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PUBMON_TEST_DB: DB_FILE }
})
server.stderr.on('data', (d) => process.stderr.write(d))
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('API running')) resolve() })
  server.on('exit', () => reject(new Error('server exited')))
  setTimeout(() => reject(new Error('server start timeout')), 15000)
})

try {
  console.log('■ 旧关联迁移')
  const crises = await api('/crisis')
  const old = crises.find((c) => c.title === '旧危机事件')
  ok(old && old.alert_titles === '投诉类话题升温', 'crisis.alert_id 已迁移为承接关系', JSON.stringify(old?.alert_titles))

  const alertsData = await api('/alerts')
  const rule = alertsData.alerts.find((a) => a.title === '投诉类话题升温')
  ok(rule && rule.merge_topic === 1 && rule.merge_window === 24, '旧规则补齐归并配置默认值（按话题/24h）')

  console.log('■ 历史时间线保留')
  const rv = await api(`/crisis/${old.id}/review`)
  ok(rv.timeline.length === 2 && rv.timeline.some((t) => t.note === '历史：高等级预警触发') && rv.timeline.some((t) => t.note === '历史：已发布回应'),
    '历史时间线 2 条原样保留', JSON.stringify(rv.timeline.map((t) => t.note)))
  ok(rv.stats.byRule.length === 1 && rv.stats.byRule[0].triggers === 1, '回溯统计覆盖迁移后的关联')

  console.log('■ 迁移后归并生效')
  const m = await api('/posts', 'POST', { title: '发货问题再遭投诉', content: '发货慢，投诉无门。', topic: '电商物流', source_id: 1 })
  const t = m.triggered.find((x) => x.alert === '投诉类话题升温')
  ok(t && t.crisisId === old.id && t.deduped === true, '新触发按迁移后的关联去重并入旧事件', JSON.stringify(m.triggered))
  const rv2 = await api(`/crisis/${old.id}/review`)
  ok(rv2.timeline.length === 3 && rv2.timeline.some((t) => t.note === '历史：已发布回应'), '新触发追加时间线，历史记录仍在')
} finally {
  server.kill()
  fs.rmSync(DB_FILE, { force: true })
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
