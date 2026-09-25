<template>
  <div class="posts">
    <div class="toolbar">
      <form class="filters" @submit.prevent="load">
        <select v-model="f.sentiment"><option value="all">全部情感</option><option value="positive">正面</option><option value="neutral">中性</option><option value="negative">负面</option></select>
        <select v-model="f.source"><option value="all">全部渠道</option><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="f.q" placeholder="搜索关键词…" />
        <button class="btn" type="submit">查询</button>
      </form>
      <button class="add" @click="showAdd=!showAdd">＋ 录入舆情</button>
      <button class="batch" @click="showBatch=!showBatch">📥 批量导入</button>
    </div>

    <form v-if="showAdd" class="add-form" @submit.prevent="submit">
      <input v-model="form.title" placeholder="标题" required />
      <textarea v-model="form.content" placeholder="舆情正文（将自动进行情感分析）" required></textarea>
      <div class="row">
        <select v-model="form.source_id"><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <input v-model="form.topic" placeholder="话题分类" />
        <input v-model="form.media" placeholder="来源媒体，如 澎湃新闻" />
      </div>
      <div class="row">
        <button class="save" type="submit">收录并分析</button>
        <button type="button" class="ghost" @click="showAdd=false">取消</button>
      </div>
    </form>

    <div v-if="showBatch" class="batch-panel">
      <div class="hint">
        每行一条，格式 <code>标题|正文|话题|来源媒体</code>（话题、媒体可省）。统一渠道：
        <select v-model="batchSource"><option v-for="s in store.sources" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <span class="cnt">共 {{ batchCount }} 条 · 任一失败将整体回滚</span>
      </div>
      <textarea v-model="batchText" rows="6" placeholder="某品牌售后拖延引投诉|多位用户反映客服响应慢，投诉量上升。|产品体验|澎湃新闻"></textarea>
      <div class="row">
        <button class="save" :disabled="importing" @click="submitBatch">{{ importing ? '导入中…' : '校验并导入' }}</button>
        <button class="ghost" @click="showBatch=false;batchResult=null;batchError=''">取消</button>
      </div>
      <div v-if="batchError" class="err">
        ❌ {{ batchError }}
        <ul v-if="batchErrDetails.length"><li v-for="d in batchErrDetails" :key="d">{{ d }}</li></ul>
      </div>
      <div v-if="batchResult" class="result">
        <div class="sum">
          ✅ 成功导入 {{ batchResult.imported }} 条，统计已刷新
          <template v-if="batchResult.summary.alerts">
            · 触发预警 {{ batchResult.summary.alerts }} 次（自动建档 {{ batchResult.summary.crisesCreated }} · 并入 {{ batchResult.summary.crisesMerged }}）
          </template>
        </div>
        <div v-for="(r, i) in batchResult.results" :key="r.id" class="ritem">
          <span class="no">#{{ i + 1 }}</span>
          <span class="chip sent" :class="r.sentiment">{{ sentText(r.sentiment) }}</span>
          <span class="heat">热度 {{ r.heat }}</span>
          <span class="rt">{{ r.title }}</span>
          <span v-if="r.triggered.length" class="trig">⚠️ {{ trigText(r.triggered) }}</span>
        </div>
      </div>
    </div>

    <div class="list">
      <div v-for="p in posts" :key="p.id" class="post" :class="p.sentiment">
        <div class="head">
          <span class="chip sent" :class="p.sentiment">{{ sentText(p.sentiment) }}</span>
          <span class="score"><i :style="scoreBar(p.sentiment_score)"></i>{{ (p.sentiment_score>=0?'+':'')+p.sentiment_score.toFixed(2) }}</span>
          <span v-if="p.hot" class="hot">🔥 热点</span>
          <span class="heat">热度 {{ p.heat }}</span>
          <span class="time">{{ p.published }}</span>
        </div>
        <b class="title">{{ p.title }}</b>
        <p class="content">{{ p.content }}</p>
        <div class="meta">
          <span class="src">{{ srcName(p.source_id) }}</span>
          <span class="topic">#{{ p.topic }}</span>
          <span class="media">{{ p.media }}</span>
        </div>
      </div>
      <div v-if="!posts.length" class="none">没有匹配的舆情</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const posts = ref([])
const f = ref({ sentiment: 'all', source: 'all', q: '' })
const showAdd = ref(false)
const form = ref({ title: '', content: '', source_id: null, topic: '', media: '' })
const showBatch = ref(false)
const batchText = ref('')
const batchSource = ref(1)
const importing = ref(false)
const batchResult = ref(null)
const batchError = ref('')
const batchErrDetails = ref([])

const batchCount = computed(() => batchText.value.split('\n').filter((l) => l.trim()).length)

async function load() {
  const qs = {}
  if (f.value.sentiment !== 'all') qs.sentiment = f.value.sentiment
  if (f.value.source !== 'all') qs.source = f.value.source
  if (f.value.q) qs.q = f.value.q
  posts.value = await store.fetchPosts(qs)
}
async function submit() {
  try {
    await store.addPost({ ...form.value, source_id: Number(form.value.source_id || 1) })
    form.value = { title: '', content: '', source_id: null, topic: '', media: '' }
    showAdd.value = false
    load()
  } catch (e) { store.msg(e.message, 'warn') }
}
// 解析批量文本：每行 标题|正文|话题|来源媒体，行级校验
function parseBatch() {
  const items = [], errs = []
  batchText.value.split('\n').forEach((line, i) => {
    const t = line.trim()
    if (!t) return
    const [title, content, topic, media] = t.split('|').map((s) => (s || '').trim())
    if (!title || !content) { errs.push(`第 ${i + 1} 行：标题与正文不能为空`); return }
    items.push({ title, content, topic, media, source_id: Number(batchSource.value) || 1 })
  })
  return { items, errs }
}
async function submitBatch() {
  batchError.value = ''; batchErrDetails.value = []; batchResult.value = null
  const { items, errs } = parseBatch()
  if (errs.length) { batchError.value = '格式校验未通过，未导入任何数据'; batchErrDetails.value = errs; return }
  if (!items.length) { batchError.value = '没有可导入的数据'; return }
  importing.value = true
  try {
    batchResult.value = await store.importPosts(items)
    batchText.value = ''
    load()
  } catch (e) {
    batchError.value = e.message // 后端已整体回滚
  } finally { importing.value = false }
}
function trigText(triggered) {
  return triggered.map((t) =>
    t.deduped ? `${t.alert}（并入危机 #${t.crisisId}）`
      : t.crisisId ? `${t.alert}（自动建档 #${t.crisisId}）` : t.alert).join('、')
}
function sentText(x) { return x === 'positive' ? '😊 正面' : x === 'negative' ? '😟 负面' : '😐 中性' }
function scoreBar(score) { const w = Math.min(100, Math.abs(score) * 100); return { width: w + '%', background: score >= 0 ? '#66bb6a' : '#ef5350' } }
function srcName(id) { return store.sources.find((s) => s.id === id)?.name || '未知' }
onMounted(load)
</script>

<style scoped>
.posts{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
.filters{display:flex;gap:8px;flex-wrap:wrap;}
select,input,textarea,button{font-family:inherit;background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#dbe4f3;border-radius:8px;padding:8px 10px;font-size:12px;}
textarea{resize:vertical;min-height:56px;}
.btn{background:#2962ff;border:none;color:#fff;cursor:pointer;font-weight:600;}
.add{background:linear-gradient(135deg,#43a047,#2e7d32);border:none;color:#fff;font-weight:600;cursor:pointer;}
.batch{background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;font-weight:600;cursor:pointer;}
.batch-panel{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.batch-panel .hint{font-size:12px;color:#8ba2c8;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.batch-panel .hint code{background:#0c1730;padding:2px 6px;border-radius:4px;color:#90caf9;}
.batch-panel .cnt{margin-left:auto;color:#5b6f94;font-size:11px;}
.batch-panel textarea{width:100%;box-sizing:border-box;}
.err{background:#3a1215;border:1px solid #b71c1c;color:#ef9a9a;border-radius:8px;padding:10px 12px;font-size:12px;}
.err ul{margin:6px 0 0;padding-left:18px;}
.result{background:#0c1730;border:1px solid rgba(120,160,220,0.16);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
.result .sum{color:#a5d6a7;font-size:12px;font-weight:600;}
.ritem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#aebadd;border-top:1px dashed rgba(120,160,220,0.12);padding-top:6px;}
.ritem .no{color:#5b6f94;font-size:11px;}
.ritem .rt{color:#dbe4f3;}
.ritem .trig{color:#ffb300;font-size:11px;}
.add-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.add-form .row:last-child{margin-top:4px;}
.save{background:#2962ff;border:none;color:#fff;font-weight:600;cursor:pointer;}
.ghost{background:#16263f;color:#8ba2c8;cursor:pointer;}
.list{display:flex;flex-direction:column;gap:12px;}
.post{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;border-left:4px solid #90a4ae;}
.post.negative{border-left-color:#ef5350;}.post.positive{border-left-color:#66bb6a;}.post.neutral{border-left-color:#90a4ae;}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;}
.chip{font-size:11px;padding:2px 8px;border-radius:6px;}
.chip.positive{background:#1b5e20;color:#a5d6a7;}.chip.negative{background:#b71c1c;color:#ffcdd2;}.chip.neutral{background:#37474f;color:#b0bec5;}
.score{display:flex;align-items:center;gap:5px;color:#8ba2c8;font-size:11px;}
.score i{height:5px;border-radius:3px;width:40px;background:#0c1730;}
.hot{font-size:10px;color:#ffd54f;}
.heat{font-size:11px;color:#ffb300;}
.time{margin-left:auto;color:#5b6f94;font-size:11px;}
.title{color:#fff;font-size:15px;display:block;margin-bottom:4px;}
.content{color:#aebadd;font-size:13px;line-height:1.5;margin:0 0 8px;}
.meta{display:flex;gap:12px;font-size:11px;color:#8ba2c8;}
.src{font-weight:600;}
.topic{color:#90caf9;}
.media{color:#5b6f94;}
.none{color:#5b6f94;text-align:center;padding:30px;}
</style>