// 危机归并判定（纯函数，便于单测）：按话题 + 时间窗口决定新触发并入既有事件还是单独建档

// 话题匹配：规则未启用话题归并，或任一侧话题缺失时不阻断
export function topicMatch(rule, crisisTopic, postTopic) {
  if (!rule.merge_topic) return true
  if (!crisisTopic || !postTopic) return true
  return crisisTopic === postTopic
}

// 时间窗口：merge_window 为小时数，0/负数表示不限；以危机最近更新时间为准
export function withinWindow(rule, crisisUpdated, nowMs) {
  const w = Number(rule.merge_window) || 0
  if (w <= 0) return true
  const t = Date.parse(crisisUpdated) // 库存 zh-CN 时间串（如 2026/9/26 01:50:20）可被 V8 解析
  if (Number.isNaN(t)) return true
  return nowMs - t <= w * 3600 * 1000
}

// 从候选危机（同规则、未结案）中挑出可归并的事件：最近更新优先
export function pickMergeCandidate(candidates, rule, postTopic, nowMs) {
  const sorted = [...candidates].sort(
    (a, b) => (Date.parse(b.updated) - Date.parse(a.updated)) || (b.id - a.id)
  )
  return sorted.find((c) => topicMatch(rule, c.topic, postTopic) && withinWindow(rule, c.updated, nowMs)) || null
}

// 候选存在但不满足归并条件时，给出单独建档的原因说明
export function mergeRejectReason(rule, crisis, postTopic, nowMs) {
  const reasons = []
  if (!topicMatch(rule, crisis.topic, postTopic)) reasons.push('话题不同')
  if (!withinWindow(rule, crisis.updated, nowMs)) reasons.push('超出归并时间窗口')
  return reasons.join('、')
}
