// 集成测试：通过 sql.js 垫片启动真实服务器，验证危机归并闭环
// 运行：node test/integration.mjs
import { spawn } from 'node:child_process'

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

// 启动服务器（node:sqlite → sql.js 垫片，内存库）
const server = spawn('node', ['--no-warnings', '--loader', './test/shim-loader.mjs', 'server/index.js'], {
  cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe']
})
server.stderr.on('data', (d) => process.stderr.write(d))
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => { if (String(d).includes('API running')) resolve() })
  server.on('exit', () => reject(new Error('server exited')))
  setTimeout(() => reject(new Error('server start timeout')), 15000)
})

try {
  // ===== 1. 种子数据：一事多规 + 同规则分别建档 =====
  console.log('■ 种子数据')
  const crises = await api('/crisis')
  const c1 = crises.find((c) => c.title === '某连锁品牌门店卫生事件')
  const c2 = crises.find((c) => c.title === '电商预售发货投诉事件')
  const c4 = crises.find((c) => c.title === '新能源充电服务投诉事件')
  ok(c1 && c1.alert_titles === '负面情绪集中爆发、负面高热舆情', 'c1 承接两条规则', JSON.stringify(c1?.alert_titles))
  ok(c1.topic === '食品安全', 'c1 话题为食品安全')
  ok(c2 && c4 && c2.alert_titles === '投诉类话题升温' && c4.alert_titles === '投诉类话题升温', '同规则 a2 下两个事件分别建档')
  ok(c2.topic === '电商物流' && c4.topic === '新能源', 'c2/c4 话题各自独立')

  const rv1 = await api(`/crisis/${c1.id}/review`)
  ok(rv1.stats.byRule.length === 2, 'c1 回溯按规则分组统计（2 条规则）')
  ok(rv1.stats.triggers === 2 && rv1.stats.byRule.every((r) => r.triggers === 1), 'c1 触发统计=2，每规则各 1')

  // ===== 2. 同话题+窗口内 → 去重并入 =====
  console.log('■ 归并：同话题窗口内并入既有事件')
  const m1 = await api('/posts', 'POST', { title: '电商发货依旧缓慢引投诉', content: '用户反映发货慢，投诉后客服无回应。', topic: '电商物流', source_id: 1 })
  const t1 = m1.triggered.find((t) => t.alert === '投诉类话题升温')
  ok(t1 && t1.crisisId === c2.id && t1.deduped === true, '同话题触发并入 c2', JSON.stringify(m1.triggered))
  const rv2 = await api(`/crisis/${c2.id}/review`)
  ok(rv2.timeline.some((t) => t.action === '预警再次触发'), 'c2 时间线记录「预警再次触发」')

  // ===== 3. 话题不同 → 单独建档 =====
  console.log('■ 分别处置：话题不同单独建档')
  // 控制热度 <85，避免命中「负面高热舆情」（不限话题/不限时间，会并入 c1）
  const m2 = await api('/posts', 'POST', { title: '某餐饮品牌出餐慢遭投诉', content: '出餐慢且投诉无人处理。', topic: '餐饮消费', source_id: 1 })
  const t2 = m2.triggered.find((t) => t.alert === '投诉类话题升温')
  ok(m2.triggered.length === 1 && t2 && t2.crisisId && t2.crisisId !== c2.id && t2.crisisId !== c4.id && t2.deduped === false, '新话题单独建档', JSON.stringify(m2.triggered))
  const rv3 = await api(`/crisis/${t2.crisisId}/review`)
  ok(rv3.crisis.topic === '餐饮消费', '新事件话题=餐饮消费')
  ok(rv3.timeline[0].note.includes('话题不同') && rv3.timeline[0].note.includes('单独建档'), '时间线注明单独建档原因', rv3.timeline[0].note)

  // ===== 4. 同一事件承接多条规则 =====
  console.log('■ 一事多规：同帖命中多规则并入同一危机')
  const m3 = await api('/posts', 'POST', { title: '涉事门店后厨卫生再曝新问题', content: '后厨卫生差，投诉不断，回应迟缓，用户不满吐槽。', topic: '食品安全', source_id: 1 })
  const auto3 = m3.triggered.filter((t) => t.crisisId)
  ok(auto3.length === 3 && auto3.every((t) => t.crisisId === c1.id && t.deduped), '三条规则同帖触发，并入同一危机 c1', JSON.stringify(m3.triggered))
  const rv4 = await api(`/crisis/${c1.id}/review`)
  const byTitle = Object.fromEntries(rv4.stats.byRule.map((r) => [r.title, r.triggers]))
  ok(rv4.stats.triggers === 5 && byTitle['负面情绪集中爆发'] === 2 && byTitle['负面高热舆情'] === 2 && byTitle['投诉类话题升温'] === 1,
    'c1 按规则分组统计：a1×2 a5×2 a2×1', JSON.stringify(rv4.stats.byRule))

  // ===== 5. 既有事件承接新规则 =====
  console.log('■ 规则承接：既有事件承接新规则')
  await api('/alerts', 'POST', { title: '维权舆情监控', level: 'red', keyword: '维权', sentiment: 'negative', heat_min: 0, merge_topic: false, merge_window: 0 })
  const m4 = await api('/posts', 'POST', { title: '消费者就门店卫生问题集体维权', content: '卫生问题发酵，用户不满吐槽，集体维权要求退款。', topic: '食品安全', source_id: 1 })
  const rv5 = await api(`/crisis/${c1.id}/review`)
  ok(rv5.rules.some((r) => r.title === '维权舆情监控'), 'c1 承接新规则「维权舆情监控」')
  ok(rv5.timeline.some((t) => t.action === '规则承接'), '时间线记录「规则承接」')
  ok(rv5.stats.byRule.length === 4, 'c1 回溯统计覆盖 4 条规则')

  // ===== 6. 预警解除同步 =====
  console.log('■ 预警解除')
  const openEv = rv5.events.find((e) => e.status === 'open')
  const rs1 = await api(`/alert-events/${openEv.id}/resolve`, 'POST', { note: '测试单条解除' })
  ok(rs1.ok && typeof rs1.openLeft === 'number', `单条解除，剩余未解除=${rs1.openLeft}`)
  const rv6 = await api(`/crisis/${c1.id}/review`)
  ok(rv6.timeline.some((t) => t.action === '预警解除' && t.note === '测试单条解除'), '解除说明同步到危机时间线')
  const alertsData = await api('/alerts')
  const a2 = alertsData.alerts.find((a) => a.title === '投诉类话题升温')
  const rs2 = await api(`/alerts/${a2.id}/resolve`, 'POST', {})
  ok(rs2.resolved >= 3, `按规则批量解除 ${rs2.resolved} 条（跨 c2/c4/新事件）`)
  const rvC2 = await api(`/crisis/${c2.id}/review`)
  const rvC4 = await api(`/crisis/${c4.id}/review`)
  ok(rvC2.timeline.some((t) => t.action === '预警解除') && rvC4.timeline.some((t) => t.action === '预警解除'), '批量解除按危机分别写时间线')

  // ===== 7. 结案级联 =====
  console.log('■ 危机结案')
  const cl = await api(`/crisis/${c4.id}/close`, 'POST', { summary: '测试结案总结' })
  ok(cl.ok, 'c4 结案')
  const rv7 = await api(`/crisis/${c4.id}/review`)
  ok(rv7.crisis.status === 'closed' && rv7.stats.open === 0, 'c4 结案后无未解除预警')
  ok(rv7.timeline[0].action === '事件结案' && rv7.timeline[0].note.includes('测试结案总结'), '结案总结写入时间线')

  // ===== 8. 结案后同规则再触发 → 新事件 =====
  console.log('■ 结案后再触发')
  // 控制热度 <85，仅命中「投诉类话题升温」
  const m5 = await api('/posts', 'POST', { title: '充电服务投诉再起', content: '充电桩故障投诉。', topic: '新能源', source_id: 5 })
  const t5 = m5.triggered.find((t) => t.alert === '投诉类话题升温')
  ok(t5 && t5.crisisId !== c4.id && t5.deduped === false, '已结案事件不并入，重新建档')

  // ===== 9. 批量导入汇总（同危机多规则去重计数） =====
  console.log('■ 批量导入')
  const batch = await api('/posts/batch', 'POST', {
    items: [
      { title: '门店卫生维权升级', content: '卫生问题维权，用户不满吐槽，回应迟缓。', topic: '食品安全', source_id: 1 },
      { title: '普通行业新闻', content: '行业平稳发展，未见异常波动。', topic: '行业', source_id: 3 }
    ]
  })
  ok(batch.ok && batch.imported === 2, '批量导入 2 条')
  ok(batch.summary.crisesMerged === 1, `并入危机去重计数=1（实际 ${batch.summary.crisesMerged}）`)
} finally {
  server.kill()
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
