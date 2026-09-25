import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'pubmon.db'))

db.exec('PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  sentiment TEXT NOT NULL,        -- positive/neutral/negative
  sentiment_score REAL NOT NULL,  -- -1..1
  heat INTEGER NOT NULL,          -- 热度 0-100
  hot INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hot_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  weight INTEGER NOT NULL,
  sentiment TEXT NOT NULL DEFAULT 'neutral'
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,            -- red/orange/yellow
  keyword TEXT NOT NULL DEFAULT '',
  sentiment TEXT NOT NULL DEFAULT '',
  heat_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  trigger_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL,
  post_id INTEGER,
  crisis_id INTEGER,              -- 关联危机事件（高等级预警自动建档/并入）
  detail TEXT NOT NULL,
  time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open/resolved（预警是否解除）
  resolved TEXT                   -- 解除时间
);
CREATE TABLE IF NOT EXISTS crisis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL,           -- monitoring/disposal/closed
  plan TEXT NOT NULL DEFAULT '',
  analysis TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  linked_email TEXT NOT NULL DEFAULT '',
  keyword TEXT NOT NULL DEFAULT '',
  alert_id INTEGER,               -- 来源预警规则（自动建档时写入）
  origin TEXT NOT NULL DEFAULT 'manual'  -- auto/manual
);
CREATE TABLE IF NOT EXISTS crisis_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  crisis_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL
);
`)

// 旧库迁移：缺列则补齐（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
ensureColumn('alert_events', 'crisis_id', 'crisis_id INTEGER')
ensureColumn('alert_events', 'status', "status TEXT NOT NULL DEFAULT 'open'")
ensureColumn('alert_events', 'resolved', 'resolved TEXT')
ensureColumn('crisis', 'alert_id', 'alert_id INTEGER')
ensureColumn('crisis', 'origin', "origin TEXT NOT NULL DEFAULT 'manual'")

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM posts').get().c
  if (n > 0) return
  const now = new Date()
  const nowStr = now.toLocaleString('zh-CN')

  const si = db.prepare('INSERT INTO sources VALUES (?,?)')
  const sources = [['微博'], ['微信'], ['新闻'], ['知乎'], ['抖音'], ['论坛']]
  sources.forEach((s, i) => si.run(i + 1, s[0]))
  const srcName = (i) => sources[i - 1][0]

  // 舆情模拟数据
  const sample = [
    // [title, content, sourceIdx, sentiment, score, heat, hot, topic, media]
    ['某电商平台预售商品迟迟不发货引用户吐槽', '网友晒出多份订单截图，称下单后近两周仍未发货，客服回应迟缓，引发大量讨论。', 1, 'negative', -0.7, 82, 1, '电商物流', '新浪科技'],
    ['新上线的某支付功能被指流程繁琐', '多位用户在社交平台反映新功能需多次验证，操作成本高，官方暂无明确回应。', 3, 'negative', -0.55, 67, 1, '产品体验', '知乎热议'],
    ['某出行企业发布年度服务质量报告', '报告显示投诉率同比下降，用户满意度多项指标回升，业内普遍关注。', 4, 'positive', 0.62, 58, 0, '企业动态', '行业观察'],
    ['专家谈绿色能源转型前景', '受访专家认为短期阵痛不改长期趋势，政策利好明显，市场反应积极。', 3, 'positive', 0.7, 71, 0, '行业趋势', '第一财经'],
    ['某连锁品牌被曝门店后厨卫生隐患', '暗访视频显示多位后厨操作不规范，品牌方紧急回应称已开展全面自查并关停涉事门店。', 6, 'negative', -0.82, 90, 1, '食品安全', '澎湃新闻'],
    ['城市新推惠民政策引关注', '多地同步推出惠民补贴与便民措施，市民普遍点赞落实情况。', 2, 'positive', 0.66, 55, 0, '民生', '人民日报'],
    ['电子产品新品发布会亮点解析', '新机型在续航与影像上提升明显，网友讨论热情高涨，预约量攀升。', 5, 'positive', 0.6, 63, 0, '消费电子', '微博热搜'],
    ['某地产项目延期交付业主维权', '多位业主聚集反映工程进度缓慢，项目方表示将给出补偿方案，事件仍在发酵。', 1, 'negative', -0.74, 78, 1, '房地产', '凤凰网'],
    ['行业大模型落地案例盘点', '多家企业公布行业大模型在企业效率提升上的实测数据，外界关注商业模式可持续性。', 3, 'neutral', 0.1, 49, 0, '科技', '科技媒体'],
    ['某视频平台会员涨价引发议论', '涨价公告后大量网友讨论性价比与内容质量，情绪以中性偏负为主。', 1, 'negative', -0.4, 70, 0, '平台运营', '排行榜'],
    ['社区养老新模式获好评', '多个社区试点养老互助点，老人家属反馈积极，成为正面典型。', 2, 'positive', 0.72, 52, 0, '民生', '中新社'],
    ['某新能源汽车充电服务再引分歧', '车主反映充电桩故障率偏高、客服响应慢，品牌方回应正在扩容并优化售后。', 5, 'negative', -0.66, 74, 1, '新能源', '汽车之家'],
    ['旅游旺季景区秩序引关注', '假期多景区实行预约限流，整体秩序良好，但也有排队偏长等零星抱怨。', 6, 'neutral', -0.15, 45, 0, '文旅', '本地资讯'],
    ['某外卖平台骑手权益保障进展', '平台公布骑手社保与安全培训新举措，舆论整体肯定，细则仍需观察。', 1, 'neutral', 0.2, 50, 0, '平台运营', '澎湃新闻'],
    ['科学家团队在脑机接口研究取得进展', '相关成果经权威期刊发表，引发学界乐观讨论，也被提醒需长期验证。', 3, 'positive', 0.68, 60, 0, '前沿科技', '科普中国']
  ]

  const pi = db.prepare('INSERT INTO posts (title,content,source_id,sentiment,sentiment_score,heat,hot,topic,media,published,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const base = new Date()
  sample.forEach((s, i) => {
    const pub = new Date(base.getTime() - (i * 37 + 12) * 60 * 1000).toLocaleString('zh-CN')
    pi.run(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], pub, nowStr)
  })

  const wi = db.prepare('INSERT INTO hot_words (word,weight,sentiment) VALUES (?,?,?)')
  ;[['发货慢', 40, 'negative'], ['后厨卫生', 36, 'negative'], ['延期交付', 32, 'negative'], ['充电桩', 30, 'negative'],
    ['会员涨价', 28, 'negative'], ['服务报告', 26, 'positive'], ['惠民政策', 25, 'positive'], ['绿色能源', 24, 'positive'],
    ['新品发布', 23, 'positive'], ['养老互助', 22, 'positive'], ['脑机接口', 21, 'positive'], ['景区限流', 18, 'neutral'],
    ['骑手保障', 17, 'neutral'], ['会员', 16, 'neutral'], ['大模型', 15, 'neutral']]
    .forEach((w) => wi.run(w[0], w[1], w[2]))

  const ago = (m) => new Date(now.getTime() - m * 60000).toLocaleString('zh-CN')

  const ai = db.prepare('INSERT INTO alerts (title,level,keyword,sentiment,heat_min,active,created,trigger_count) VALUES (?,?,?,?,?,?,?,?)')
  const a1 = ai.run('负面情绪集中爆发', 'red', '卫生', 'negative', 80, 1, nowStr, 1).lastInsertRowid
  const a2 = ai.run('投诉类话题升温', 'orange', '投诉', 'negative', 65, 1, nowStr, 2).lastInsertRowid
  const a3 = ai.run('选址关键词监控', 'yellow', '延期', 'negative', 60, 1, nowStr, 1).lastInsertRowid
  ai.run('正面口碑监测', 'yellow', '服务', 'positive', 50, 1, nowStr, 1)

  // 危机事件：c1 红色自动建档·处置中；c2 橙色自动建档·监测中（含去重并入）；c3 人工建档·已结案
  const ci = db.prepare('INSERT INTO crisis (title,level,status,plan,analysis,created,updated,linked_email,keyword,alert_id,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const c1 = ci.run('某连锁品牌门店卫生事件', 'red', 'disposal',
    '1. 24小时内全网回应，公布整改时间表\n2. 关停涉事门店并启动第三方复查\n3. 官方渠道连续发布整改动态\n4. 与权威媒体合作发布透明报告',
    '负面传播主阵地为短视频与微博，需在2小时内完成首次回应，重点关注转发量头部账号。',
    ago(180), ago(120), 'crisis@brand.com', '卫生', a1, 'auto').lastInsertRowid
  const c2 = ci.run('投诉类话题升温事件', 'orange', 'monitoring', '',
    '由橙色预警「投诉类话题升温」自动建档：命中关键词「投诉」，首条关联舆情《某电商平台预售商品迟迟不发货引用户吐槽》（热度82）。',
    ago(90), ago(30), '', '投诉', a2, 'auto').lastInsertRowid
  const c3 = ci.run('某视频平台会员涨价争议', 'orange', 'closed',
    '1. 发布定价说明与会员权益升级方案\n2. 客服通道集中答疑\n3. 观察期一周，舆情回落后结案',
    '情绪以中性偏负为主，未出现大规模抵制，重点回应性价比质疑。',
    ago(4320), ago(2840), '', '涨价', null, 'manual').lastInsertRowid

  // 预警触发记录：c1/c2 由预警自动建档，c2 第二次触发去重并入；黄色规则不自动建档
  const ae = db.prepare('INSERT INTO alert_events (alert_id,post_id,crisis_id,detail,time,status,resolved) VALUES (?,?,?,?,?,?,?)')
  ae.run(a1, 5, c1, '命中关键词「卫生」· 情感：negative · 热度90', ago(180), 'open', null)
  ae.run(a2, 1, c2, '命中关键词「投诉」· 情感：negative · 热度82', ago(90), 'open', null)
  ae.run(a2, 12, c2, '命中关键词「投诉」· 情感：negative · 热度74', ago(30), 'open', null)
  ae.run(a3, 8, null, '命中关键词「延期」· 情感：negative · 热度78', ago(60), 'open', null)

  const ct = db.prepare('INSERT INTO crisis_timeline (crisis_id,action,note,time) VALUES (?,?,?,?)')
  ;[['自动建档', '高等级预警触发：命中关键词「卫生」· 情感：negative · 热度90', ago(180)],
    ['全网回应', '官方发布回应声明', ago(150)],
    ['关停门店', '涉事门店暂停营业，启动自查', ago(120)]].forEach((t) => ct.run(c1, t[0], t[1], t[2]))
  ;[['自动建档', '高等级预警触发：命中关键词「投诉」· 情感：negative · 热度82', ago(90)],
    ['预警再次触发', '命中关键词「投诉」· 情感：negative · 热度74 · 关联舆情《某新能源汽车充电服务再引分歧》', ago(30)]].forEach((t) => ct.run(c2, t[0], t[1], t[2]))
  ;[['事件建档', '人工建档，进入监测', ago(4320)],
    ['启动处置', '发布定价说明，开通集中答疑', ago(4300)],
    ['预警解除', '风险指标回落，预警解除', ago(2880)],
    ['事件结案', '舆情热度回落至常态区间，负面占比降至 5% 以下，完成处置闭环。', ago(2840)]].forEach((t) => ct.run(c3, t[0], t[1], t[2]))
}
seed()