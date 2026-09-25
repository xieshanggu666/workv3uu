<template>
  <div class="alerts">
    <div class="grid">
      <!-- 规则管理 -->
      <div class="card">
        <h4>🚨 预警规则配置</h4>
        <form class="rule-form" @submit.prevent="add">
          <input v-model="form.title" placeholder="规则名称，如 负面风险" required />
          <div class="row">
            <select v-model="form.level"><option value="red">红色</option><option value="orange">橙色</option><option value="yellow">黄色</option></select>
            <input v-model="form.keyword" placeholder="关键词（留空=全部）" />
          </div>
          <div class="row">
            <select v-model="form.sentiment"><option value="">不限情感</option><option value="negative">负面</option><option value="positive">正面</option><option value="neutral">中性</option></select>
            <input v-model.number="form.heat_min" type="number" placeholder="热度下限" />
          </div>
          <button class="save" type="submit">保存规则</button>
          <p class="hint">💡 红/橙级规则触发后自动建档危机事件；同规则重复触发自动去重并入既有事件。</p>
        </form>
        <div class="rule-list">
          <div v-for="a in alertList" :key="a.id" class="rule" :class="a.level">
            <div class="r-head">
              <b>{{ a.title }}</b>
              <span class="lv">{{ a.level==='red'?'红':a.level==='orange'?'橙':'黄' }}</span>
            </div>
            <small>关键词[{{ a.keyword||'全部' }}] · {{ a.sentiment||'不限' }} · 热度≥{{ a.heat_min }}</small>
            <em>触发 {{ a.trigger_count }} 次</em>
            <span v-if="a.level!=='yellow'" class="auto-tag">🤖 自动建档</span>
            <span v-if="openCount(a.id)" class="open-tag">🔔 未解除 {{ openCount(a.id) }}</span>
            <div class="r-btns">
              <button v-if="openCount(a.id)" class="resolve" @click="resolveAll(a)">全部解除</button>
              <label class="switch">
                <input type="checkbox" :checked="!!a.active" @change="store.toggleAlert(a.id)" />
                <span></span>
              </label>
              <button class="del" @click="store.deleteAlert(a.id)">删除</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 触发记录 -->
      <div class="card">
        <h4>🕓 预警触发记录</h4>
        <div v-if="!events.length" class="none">暂无触发记录</div>
        <div class="events">
          <div v-for="e in events" :key="e.id" class="event" :class="{resolved:e.status==='resolved'}">
            <span class="e-dot" :class="eLevel(e.alert_id)"></span>
            <div class="e-body">
              <b>{{ e.detail }}</b>
              <span v-if="e.pt" class="e-post">关联：{{ e.pt }}</span>
              <span v-if="e.crisis_id" class="e-crisis">🛟 {{ e.crisis_title || '危机事件' }} #{{ e.crisis_id }}</span>
              <span v-if="e.status==='resolved'" class="e-resolved">✅ 已解除 · {{ e.resolved }}</span>
            </div>
            <div class="e-side">
              <span class="e-time">{{ e.time }}</span>
              <button v-if="e.status!=='resolved'" class="resolve" @click="resolveOne(e)">解除</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const alertList = ref([])
const events = ref([])
const form = ref({ title: '', level: 'orange', keyword: '', sentiment: '', heat_min: 60 })

async function load() {
  const d = await store.fetchAlerts()
  alertList.value = d.alerts
  events.value = d.events
}
function add() {
  store.saveAlert(form.value)
  form.value = { title: '', level: 'orange', keyword: '', sentiment: '', heat_min: 60 }
  load()
}
function eLevel(alertId) {
  const a = alertList.value.find((x) => x.id === alertId)
  return a ? a.level : ''
}
function openCount(alertId) {
  return events.value.filter((e) => e.alert_id === alertId && e.status !== 'resolved').length
}
async function resolveOne(e) {
  const note = prompt('解除说明（可留空）：', '风险指标回落，预警解除')
  if (note == null) return
  await store.resolveAlertEvent(e.id, note)
  load()
}
async function resolveAll(a) {
  if (!confirm(`解除规则「${a.title}」全部 ${openCount(a.id)} 条未解除预警？`)) return
  await store.resolveAlert(a.id)
  load()
}
onMounted(async () => { await store.load; load() })
</script>

<style scoped>
.alerts .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media(max-width:860px){.alerts .grid{grid-template-columns:1fr;}}
.card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px;}
h4{margin:0 0 12px;color:#fff;font-size:14px;}
.rule-form{display:flex;flex-direction:column;gap:8px;background:#13233f;border-radius:10px;padding:12px;margin-bottom:10px;}
input,select,button{font-family:inherit;background:#0f1b38;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row select,.row input{flex:1;min-width:100px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.rule-list{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;}
.rule{background:#16263f;border-left:4px solid #ffd54f;border-radius:8px;padding:10px 12px;position:relative;}
.rule.red{border-left-color:#ef5350;}.rule.orange{border-left-color:#ff9800;}
.r-head{display:flex;align-items:center;justify-content:space-between;}
.r-head b{color:#dbe4f3;font-size:13px;}
.lv{font-size:10px;padding:1px 7px;border-radius:5px;background:#37474f;color:#b0bec5;}
.rule small{color:#8ba2c8;font-size:10px;display:block;margin:4px 0;}
.rule em{color:#ffd54f;font-size:11px;font-style:normal;}
.auto-tag{font-size:10px;color:#90caf9;background:#0d2137;border:1px solid rgba(144,202,249,.3);border-radius:5px;padding:1px 6px;margin-left:6px;}
.open-tag{font-size:10px;color:#ffab91;background:#3e2723;border:1px solid rgba(255,138,101,.3);border-radius:5px;padding:1px 6px;margin-left:6px;}
.hint{margin:0;font-size:10px;color:#5b6f94;line-height:1.5;}
.resolve{background:none;border:1px solid rgba(102,187,106,.45);color:#81c784;cursor:pointer;border-radius:7px;padding:4px 9px;font-size:11px;}
.r-btns{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px;}
.switch{position:relative;width:36px;height:20px;display:inline-block;}
.switch input{opacity:0;width:0;height:0;}
.switch span{position:absolute;inset:0;background:#243357;border-radius:20px;transition:.2s;cursor:pointer;}
.switch span:before{content:'';position:absolute;width:16px;height:16px;left:2px;top:2px;background:#7b8db3;border-radius:50%;transition:.2s;}
.switch input:checked+span{background:#2962ff;}
.switch input:checked+span:before{transform:translateX(16px);background:#fff;}
.del{background:none;border:1px solid rgba(239,83,80,.4);color:#ef5350;cursor:pointer;}
.event{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.event:last-child{border-bottom:none;}
.event.resolved{opacity:.62;}
.e-dot{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:none;}
.e-dot.red{background:#ef5350;}.e-dot.orange{background:#ff9800;}.e-dot.yellow{background:#ffd54f;}
.e-body{flex:1;min-width:0;}
.e-body b{color:#dbe4f3;font-size:12px;display:block;}
.e-post{color:#5b6f94;font-size:10px;display:block;}
.e-crisis{color:#90caf9;font-size:10px;display:block;}
.e-resolved{color:#81c784;font-size:10px;display:block;}
.e-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none;}
.e-time{color:#5b6f94;font-size:10px;white-space:nowrap;}
.events{max-height:340px;overflow-y:auto;}
.none{color:#5b6f94;text-align:center;padding:24px;}
</style>