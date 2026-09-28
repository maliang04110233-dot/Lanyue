/**
 * AI 音乐生成视图（UI 重构版）
 *
 * 设计理念：
 *   - 顶部导航栏（Tab 切换）
 *   - 三栏布局：左设置 / 中歌词 / 右预览+操作
 *   - 卡片化设计，视觉层次清晰
 *   - 更好的空状态和加载状态
 */

import { errBrief } from '../errBrief.js';
import { askConfirm } from '../confirmDialog.js';
import { t } from '../i18n.js';

// ══════════════════════════════════════════════════════════
// 状态
// ══════════════════════════════════════════════════════════

const aiState = {
  tab: 'create',
  apiKey: '',
  generating: false,
  abortCtrl: null,
  saveDir: '',
  advancedOpen: false,
  historyCache: null,
  musicPrompt: '', // AI 生成的详细音乐描述
  voice: 'female',   // 人声偏好: female / male / choir（并进 prompt，不是独立字段）
  instrumental: false, // 纯音乐：只要曲子，不写词也不唱
  autoLyrics: false,   // 一句话直出：交给上游 lyrics_optimizer，本机不再要歌词
  model: 'music-2.6',  // 生成模型
  activeVersion: 0,   // 当前选中版本索引
  generatedVersions: [], // [{label, lyrics}]
};

// 历史 tab 渲染序号：迟到回包守卫（见 renderHistoryTab）
let _historyRenderSeq = 0;

// ══════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════

const STYLES = [
  { v: 'pop', l: '流行', i: '🎤', c: '#ff6b9d' },
  { v: 'rock', l: '摇滚', i: '🎸', c: '#ff4757' },
  { v: 'ballad', l: '民谣', i: '🎵', c: '#2ed573' },
  { v: 'electronic', l: '电子', i: '🎧', c: '#1e90ff' },
  { v: 'r&b', l: 'R&B', i: '💃', c: '#a78bfa' },
  { v: 'hip-hop', l: '嘻哈', i: '🎙️', c: '#ffa502' },
  { v: 'jazz', l: '爵士', i: '🎷', c: '#ff6348' },
  { v: 'lo-fi', l: 'Lo-Fi', i: '☕', c: '#70a1ff' },
];

const MOODS = [
  { v: 'happy', l: '快乐', i: '😊' },
  { v: 'sad', l: '悲伤', i: '😢' },
  { v: 'romantic', l: '浪漫', i: '💕' },
  { v: 'energetic', l: '激昂', i: '⚡' },
  { v: 'calm', l: '平静', i: '🌊' },
  { v: 'nostalgic', l: '怀旧', i: '🌅' },
];

// 人声偏好。上游 music_generation 请求里没有音色字段（查 2026-09 官方
// GenerateMusicReq：model/prompt/lyrics/stream/output_format/audio_setting/
// aigc_watermark/lyrics_optimizer/is_instrumental/…），只能作为 prompt 的
// 自然语言片段送进去。此前这里挂着 18 个真人歌手名当"音色"，那些值从未
// 出过本机——明星名字冒充声线既骗用户也有肖像权风险，一律退场。
const VOICES = [
  { id: 'female', name: '女声', emoji: '👩', tip: '女声主唱' },
  { id: 'male', name: '男声', emoji: '👨', tip: '男声主唱' },
  { id: 'choir', name: '合唱', emoji: '👥', tip: '合唱人声' },
];

// 可上计费接口的模型；须与 src/api/ai-music.js 的 MUSIC_MODELS 白名单一致
// （music-cover 是翻唱引擎，要先有参考音频，本增量未接，不要往这里加）
const MUSIC_MODELS = [
  { id: 'music-2.6', name: 'music-2.6（默认）' },
  { id: 'music-3.0', name: 'music-3.0' },
];

// ══════════════════════════════════════════════════════════
// 初始化
// ══════════════════════════════════════════════════════════

async function initAiMusic() {
  aiState.apiKey = await api.getPref('aiMusicApiKey') || '';
  aiState.saveDir = await api.getPref('aiMusicSaveDir') || '';
  renderAiMusicPage();
}

// ══════════════════════════════════════════════════════════
// 渲染 — 主页面
// ══════════════════════════════════════════════════════════

function renderAiMusicPage() {
  const el = document.getElementById('aiMusicContent');
  if (!el) return;
  if (aiState.tab === 'create') renderCreateTab(el);
  else renderHistoryTab(el);
}

function renderCreateTab(el) {
  el.innerHTML = `
    <div class="ai-workspace">
      ${renderSidebar()}
      <div class="ai-main">
        ${renderLyricsPanel()}
        ${renderBottomBar()}
      </div>
    </div>
  `;
  // 如果有已生成的歌词，展开结果区
  const lyricsEl = document.getElementById('aiLyricsPreviewInput');
  const resultArea = document.getElementById('aiResultArea');
  if (lyricsEl?.value && resultArea) resultArea.style.display = 'block';
}

// ══════════════════════════════════════════════════════════
// 渲染 — 侧边栏
// ══════════════════════════════════════════════════════════

function renderSidebar() {
  const hasKey = !!aiState.apiKey;
  return `
    <div class="ai-sidebar">
      <!-- API 配置 -->
      <div class="ai-card">
        <div class="ai-card-header">
          <span class="ai-card-icon">🔑</span>
          <span class="ai-card-title">API 配置</span>
        </div>
        <div class="ai-api-badge ${hasKey ? 'ok' : 'warn'}">${hasKey ? '✅ 已连接' : '⚠️ 未配置'}</div>
        <div class="ai-api-input">
          <input class="ai-input" id="aiApiKeyInput" type="password" placeholder="MiniMax API Key" value="${hasKey ? '••••••••' : ''}">
          <button class="ai-btn-action" onclick="saveAiApiKey()">保存</button>
        </div>
        ${!hasKey ? '<a class="ai-link" href="https://platform.minimaxi.com/user-center/basic-information/interface-key" target="_blank">获取 Key →</a>' : ''}
      </div>

      <!-- 风格选择 -->
      <div class="ai-card">
        <div class="ai-card-header">
          <span class="ai-card-icon">🎨</span>
          <span class="ai-card-title">音乐风格</span>
        </div>
        <div class="ai-grid-4">
          ${STYLES.map(s => `
            <button class="ai-chip ${s.v === 'pop' ? 'active' : ''}" data-style="${s.v}" onclick="selectAiStyle('${s.v}',this)">
              <span class="ai-chip-dot" style="background:${s.c}"></span>
              ${s.i} ${s.l}
            </button>
          `).join('')}
        </div>
        <input type="hidden" id="aiStyleValue" value="pop">
      </div>

      <!-- 情感选择 -->
      <div class="ai-card">
        <div class="ai-card-header">
          <span class="ai-card-icon">💭</span>
          <span class="ai-card-title">情感氛围</span>
        </div>
        <div class="ai-grid-3">
          ${MOODS.map(m => `
            <button class="ai-chip ${m.v === 'happy' ? 'active' : ''}" data-mood="${m.v}" onclick="selectAiMood('${m.v}',this)">
              ${m.i} ${m.l}
            </button>
          `).join('')}
        </div>
        <input type="hidden" id="aiMoodValue" value="happy">
      </div>

      <!-- 高级设置 -->
      <div class="ai-card">
        <button class="ai-card-toggle" onclick="toggleAdvanced()">
          ⚙️ 高级设置 <span class="ai-toggle-arrow">${aiState.advancedOpen ? '▾' : '▸'}</span>
        </button>
        <div class="ai-advanced" id="aiAdvancedPanel" style="display:${aiState.advancedOpen ? 'block' : 'none'}">
          <div class="ai-field-row">
            <label>语言</label>
            <select class="ai-select" id="aiLanguage">
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="ja">日文</option>
            </select>
          </div>
          <div class="ai-field-row">
            <label>结构</label>
            <select class="ai-select" id="aiStructure">
              <option value="short">简洁</option>
              <option value="standard" selected>标准</option>
              <option value="long">完整</option>
            </select>
          </div>
          <div class="ai-field-row">
            <label>创意度</label>
            <input type="range" class="ai-range" id="aiCreativity" min="0" max="100" value="80">
          </div>
          <div class="ai-field-row">
            <label>生成模式</label>
            <div class="ai-voice-row">
              <button class="ai-chip${aiState.instrumental ? ' active' : ''}" data-flag="instrumental"
                onclick="toggleAiFlag('instrumental',this)"
                title="只出曲子，不写词也不唱（可直接在主题里写「雨后钢琴独奏」这类描述）">🎹 纯音乐</button>
              <button class="ai-chip${aiState.autoLyrics ? ' active' : ''}" data-flag="autoLyrics"
                onclick="toggleAiFlag('autoLyrics',this)"
                title="跳过本机写词，把主题一句话交给模型自己填词开唱">✍️ 一句话直出</button>
            </div>
          </div>
          <div class="ai-field-row" id="aiVoiceRow" style="display:${aiState.instrumental ? 'none' : 'block'}">
            <label>演唱声线</label>
            <div class="ai-voice-row">
              ${VOICES.map(v => `
                <button class="ai-chip${aiState.voice === v.id ? ' active' : ''}"
                  data-voice="${v.id}" onclick="selectAiVoice('${escQ(v.id)}',this)"
                  title="${v.tip}">${v.emoji} ${v.name}</button>
              `).join('')}
            </div>
          </div>
          <div class="ai-field-row">
            <label>生成模型</label>
            <select class="ai-select" id="aiMusicModel" onchange="selectAiModel(this.value)">
              ${MUSIC_MODELS.map(m => `<option value="${m.id}"${aiState.model === m.id ? ' selected' : ''}>${m.name}</option>`).join('')}
            </select>
          </div>
          <div class="ai-field-row">
            <label>保存目录</label>
            <div class="ai-dir-input">
              <input class="ai-input" id="aiSaveDirInput" value="${esc(aiState.saveDir)}" placeholder="默认目录">
              <button class="ai-btn-action" onclick="selectAiSaveDir()">📁</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// 渲染 — 歌词面板
// ══════════════════════════════════════════════════════════

function renderLyricsPanel() {
  // 纯音乐 / 一句话直出：本机不再要歌词，主按钮换成"直接生成歌曲"
  const directMode = aiState.instrumental === true || aiState.autoLyrics === true;
  return `
    <div class="ai-lyrics-card">
      <!-- 顶部标签栏 -->
      <div class="ai-tabs-bar">
        <div class="ai-tabs-left">
          <button class="ai-tab active" data-mode="ai" onclick="switchLyricsMode('ai',this)">🤖 AI 生成</button>
          <button class="ai-tab" data-mode="manual" onclick="switchLyricsMode('manual',this)">✏️ 手动输入</button>
          <button class="ai-tab" data-mode="playlist" onclick="switchLyricsMode('playlist',this)">📋 歌单策划</button>
        </div>
        <button class="ai-btn-text" onclick="clearAiLyrics()">清空</button>
      </div>

      <!-- AI 生成模式 · 统一面板（输入 + 结果都在这里） -->
      <div id="aiLyricsAiMode" class="ai-body">
        <!-- 关键词输入区 — 始终可见 -->
        <div class="ai-prompt-box">
          <textarea class="ai-textarea-lg" id="aiTopic" rows="3"
            placeholder="输入关键词/主题...&#10;&#10;例如：&#10;夏日海滩 · 雨夜思乡 · 星空旅行 · 春日告白"></textarea>
        </div>
        <div class="ai-prompt-footer" style="margin-bottom:12px">
          <button class="ai-btn-primary" onclick="generateAiLyrics()" id="btnGenLyrics"
            style="${directMode ? 'display:none' : ''}">🎼 生成提示词+歌词</button>
          <button class="ai-btn-primary" onclick="generateAiMusic()" id="btnGenDirectMusic"
            title="不写歌词，按上面这一句话直接出歌（会计费）"
            style="${directMode ? '' : 'display:none'}">🎶 直接生成歌曲</button>
        </div>

        <!-- 生成结果区（初始隐藏，生成后展开显示在输入区下方） -->
        <div id="aiResultArea" class="ai-result-area" style="display:none">
          <!-- 音乐描述提示条 -->
          <div id="aiMusicPromptHint" style="display:none"></div>
          <!-- 工具栏：翻译 + 重新生成 + 生成歌曲 -->
          <div class="ai-preview-bar">
            <span class="ai-preview-label">📝 歌词</span>
            <div style="display:flex;gap:4px;align-items:center">
              <button class="ai-btn-action" onclick="translateLyricsUI()">🌐 翻译</button>
              <button class="ai-btn-text" onclick="regenerateAiLyrics()">🔄 重新生成</button>
              <button class="ai-btn-generate" onclick="generateAiMusic()" id="btnGenMusicResult">🎶 生成歌曲</button>
            </div>
          </div>
          <!-- 歌词编辑框（缩小，让下方标题/进度/播放按钮完整可见） -->
          <textarea class="ai-textarea-lg" id="aiLyricsPreviewInput" rows="6" placeholder="歌词将显示在这里..." style="flex:none;height:auto;min-height:120px;max-height:180px"></textarea>
          <!-- 版本切换标签（生成2个版本时显示） -->
          <div id="aiVersionTabs" class="ai-version-tabs" style="display:none;margin-top:8px"></div>
          <!-- 歌曲标题 -->
          <input class="ai-input" id="aiTitle" placeholder="歌曲标题" style="margin-top:8px">
          <!-- 简易进度（生成歌曲时显示） -->
          <div id="aiResultProgress" class="ai-progress" style="display:none;margin-top:10px">
            <div class="ai-progress-bar"><div class="ai-progress-fill" id="aiResultProgressFill"></div></div>
            <div class="ai-progress-text" id="aiResultProgressText" style="margin-top:4px">准备中...</div>
          </div>
          <!-- 生成完成后的结果卡片（播放按钮在这里） -->
          <div id="aiResultAreaCard" style="display:none;margin-top:10px"></div>
        </div>
      </div>

      <!-- 手动输入模式 -->
      <div id="aiLyricsManualMode" class="ai-body" style="display:none">
        <textarea class="ai-textarea-lg" id="aiLyrics" rows="14"
          placeholder="在此输入歌词...&#10;&#10;支持结构标签：&#10;[主歌] [副歌] [桥段] [结尾]"></textarea>
      </div>

      <!-- AI 歌单策划模式 -->
      <div id="aiPlaylistMode" class="ai-body" style="display:none">
        <div class="ai-prompt-box">
          <textarea class="ai-textarea-lg" id="aiPlaylistDesc" rows="4"
            placeholder="描述你想要的歌单...&#10;&#10;例如：&#10;10首适合深夜开车的歌曲&#10;风格：流行/R&B&#10;氛围：放松、略带忧伤"></textarea>
        </div>
        <div class="ai-prompt-footer">
          <select class="ai-select" id="aiPlaylistCount" style="width:100px">
            <option value="5">5首</option>
            <option value="10" selected>10首</option>
            <option value="15">15首</option>
            <option value="20">20首</option>
          </select>
          <button class="ai-btn-primary" onclick="generateAiPlaylist()" id="btnGenPlaylist">📋 生成歌单</button>
        </div>
        <div id="aiPlaylistResult" style="display:none;margin-top:12px">
          <div class="ai-preview-bar">
            <span class="ai-preview-label">📋 推荐歌单</span>
            <button class="ai-btn-text" onclick="addAllPlaylistToQueue()">📥 全部加入队列</button>
          </div>
          <div id="aiPlaylistList" class="ai-playlist-list"></div>
        </div>
      </div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// 渲染 — 底部操作栏
// ══════════════════════════════════════════════════════════

function renderBottomBar() {
  return `
    <div class="ai-bottom-card">
      <div class="ai-bottom-left">
        <span class="ai-hint-text">💡 歌词越长，音乐越长</span>
      </div>
      <div class="ai-bottom-right">
        ${aiState.generating ? '<button class="ai-btn-cancel" onclick="cancelAiGeneration()">取消</button>' : ''}
      </div>
      <div id="aiResultSection" style="display:none"><div id="aiResult"></div></div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// 渲染 — 历史标签页
// ══════════════════════════════════════════════════════════

function renderHistoryTab(el) {
  // 序号守卫：连续切 tab / 快速重渲染时，迟到的历史回包不得覆盖当前 tab
  const seq = ++_historyRenderSeq;
  el.innerHTML = '<div class="ai-empty"><div class="ai-spinner-lg"></div><span class="ai-loading-text">加载中...</span></div>';

  loadAiHistory().then(items => {
    if (seq !== _historyRenderSeq || aiState.tab !== 'history') return;
    if (!items.length) {
      el.innerHTML = `
        <div class="ai-empty">
          <div class="ai-empty-icon">🎵</div>
          <div class="ai-empty-title">暂无生成历史</div>
          <div class="ai-empty-desc">使用 AI 创作功能生成歌曲后会显示在这里</div>
          <button class="ai-btn-primary" onclick="switchAiTab('create')">✨ 开始创作</button>
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="ai-history-header-bar">
        <h3 class="ai-section-title">生成历史</h3>
        <button class="ai-btn-danger" onclick="clearAiHistory()">🗑 清空</button>
      </div>
      <div class="ai-history-grid">
        ${items.map(it => `
          <div class="ai-history-card">
            <div class="ai-history-top">
              <div class="ai-history-avatar">🎵</div>
              <div class="ai-history-meta">
                <div class="ai-history-name">${esc(it.title)}</div>
                <div class="ai-history-detail">${esc(it.style || '流行')} · ${fmtAiDate(it.createdAt)}</div>
              </div>
            </div>
            ${it.lyrics ? `<div class="ai-history-lyrics">${esc(it.lyrics.substring(0, 100))}${it.lyrics.length > 100 ? '...' : ''}</div>` : ''}
            <div class="ai-history-actions">
              ${it.audioPath ? `<button class="ai-btn-action" onclick="playAiSong('${escQ(it.audioPath)}')">▶ 播放</button>` : ''}
              <button class="ai-btn-action" onclick="regenerateFromHistory('${escQ(JSON.stringify(it))}')">🔄 重生成</button>
              <button class="ai-btn-action" onclick="showAiLyricsDetail('${escQ(JSON.stringify(it.lyrics || ''))}')">📝</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="ai-history-footer">
        <span class="ai-history-count">共 ${items.length} 首歌曲</span>
      </div>
    `;
  }).catch(e => {
    if (seq !== _historyRenderSeq || aiState.tab !== 'history') return;
    el.innerHTML = '<div class="ai-empty"><div class="ai-empty-icon">⚠️</div><div class="ai-empty-title">加载失败</div></div>';
    logger.warn('[aiHistory] 加载失败:', e.message);
  });
}

// ══════════════════════════════════════════════════════════
// 交互
// ══════════════════════════════════════════════════════════

function selectAiStyle(v, btn) {
  document.getElementById('aiStyleValue').value = v;
  document.querySelectorAll('.ai-grid-4 .ai-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function selectAiMood(v, btn) {
  document.getElementById('aiMoodValue').value = v;
  document.querySelectorAll('.ai-grid-3 .ai-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function switchLyricsMode(mode, btn) {
  document.querySelectorAll('.ai-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const aiEl = document.getElementById('aiLyricsAiMode');
  const manualEl = document.getElementById('aiLyricsManualMode');
  const playlistEl = document.getElementById('aiPlaylistMode');
  
  // 隐藏所有
  aiEl.style.display = 'none';
  manualEl.style.display = 'none';
  playlistEl.style.display = 'none';
  
  // 显示选中的
  if (mode === 'ai') aiEl.style.display = 'flex';
  else if (mode === 'manual') manualEl.style.display = 'flex';
  else if (mode === 'playlist') playlistEl.style.display = 'flex';
}

function toggleAdvanced() {
  aiState.advancedOpen = !aiState.advancedOpen;
  const panel = document.getElementById('aiAdvancedPanel');
  const arrow = document.querySelector('.ai-toggle-arrow');
  if (panel) panel.style.display = aiState.advancedOpen ? 'block' : 'none';
  if (arrow) arrow.textContent = aiState.advancedOpen ? '▾' : '▸';
}

function clearAiLyrics() {
  const l = document.getElementById('aiLyricsPreviewInput');
  const titleEl = document.getElementById('aiTitle');
  const hint = document.getElementById('aiMusicPromptHint');
  const resultArea = document.getElementById('aiResultArea');
  if (l) l.value = '';
  if (titleEl) titleEl.value = '';
  if (hint) { hint.style.display = 'none'; }
  if (resultArea) resultArea.style.display = 'none';
  aiState.musicPrompt = '';
}

function switchAiTab(tab) {
  aiState.tab = tab;
  document.querySelectorAll('.ai-tabs .ai-tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  renderAiMusicPage();
}

// ══════════════════════════════════════════════════════════
// API 操作
// ══════════════════════════════════════════════════════════

async function saveAiApiKey() {
  const input = document.getElementById('aiApiKeyInput');
  if (!input) return;
  const key = input.value.trim();
  if (!key || key.startsWith('•••')) { showToast(t('toast.aiKeyInvalid'), 'warn'); return; }
  // 审计 P1：安全存储不可用时主进程会拒绝写入（set-pref 返回 false）——
  // 旧代码无视返回值直接报「已保存」，用户以为存上了，实际盘上什么都没有。
  const saved = await api.setPref('aiMusicApiKey', key);
  if (saved === false) {
    showToast(t('toast.secretStorageUnavailable'), 'error', 8000);
    return;
  }
  aiState.apiKey = key;
  showToast(t('toast.aiKeySaved'), 'success');
  input.value = '••••••••';
  renderAiMusicPage();
}

async function selectAiSaveDir() {
  const dir = await api.selectDir();
  if (dir) { aiState.saveDir = dir; await api.setPref('aiMusicSaveDir', dir); const el = document.getElementById('aiSaveDirInput'); if (el) el.value = dir; }
}

async function generateAiLyrics() {
  if (!aiState.apiKey) { showToast(t('toast.aiApiKeyMissing'), 'warn'); return; }
  const topic = document.getElementById('aiTopic')?.value?.trim();
  if (!topic) { showToast(t('toast.aiTopicRequired'), 'warn'); document.getElementById('aiTopic')?.focus(); return; }

  const btn = document.getElementById('btnGenLyrics');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 创作中...'; }

  try {
    // 精简入参：只传关键词+风格，AI 同时生成音乐描述和歌词
    const result = await api.aiGenerateLyrics({
      topic,
      style: document.getElementById('aiStyleValue')?.value || 'pop',
      apiKey: aiState.apiKey,
    });

    if (result.error) { showToast(t('toast.aiLyricsFailed', { msg: result.error }), 'error'); return; }

    // 存储 AI 生成的音乐描述
    aiState.musicPrompt = result.musicPrompt || '';

    // ★ 处理多版本歌词（2个版本或降级单版本）
    const versions = result.versions || [{ label: '版本', lyrics: result.lyrics || '' }];

    // 展开结果区（在统一面板内，输入区下方）
    const resultArea = document.getElementById('aiResultArea');
    if (resultArea) resultArea.style.display = 'block';

    // 默认显示第一个版本
    aiState.generatedVersions = versions;
    aiState.activeVersion = 0;
    document.getElementById('aiLyricsPreviewInput').value = versions[0].lyrics;
    document.getElementById('aiTitle').value = result.title || topic;

    // 渲染版本切换标签
    renderVersionTabs();
    // 自动滚动到结果区，让用户看到歌词和生成歌曲按钮
    setTimeout(() => resultArea?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

    // 如果存在音乐描述，在标题下方显示提示
    if (aiState.musicPrompt) {
      const titleEl = document.getElementById('aiTitle');
      let hint = document.getElementById('aiMusicPromptHint');
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'aiMusicPromptHint';
        hint.style.cssText = 'font-size:12px;color:#888;margin-top:4px;padding:4px 8px;background:rgba(255,255,255,0.03);border-radius:4px;border-left:2px solid #a78bfa;';
        titleEl.parentNode.insertBefore(hint, titleEl.nextSibling);
      }
      hint.textContent = '🎵 音乐描述: ' + aiState.musicPrompt;
      hint.style.display = 'block';
    }

    showToast(t('toast.aiLyricsDone'), 'success');
  } catch (e) { showToast(t('toast.aiGenFailed', { msg: errBrief(e) }), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🎼 生成歌词'; } }
}

async function generateAiMusic() {
  if (!aiState.apiKey) { showToast(t('toast.aiApiKeyMissing'), 'warn'); return; }
  if (aiState.generating) { showToast(t('toast.aiGenerating'), 'warn'); return; }

  // 确定要生成哪些版本
  // 直出模式（纯音乐 / 一句话直出）本机不发歌词，歌词版本之间也就没有区别，
  // 所以固定只出一首：多提交一次就是多扣一次费。
  const instrumental = aiState.instrumental === true;
  const autoLyrics = aiState.autoLyrics === true;
  const directMode = instrumental || autoLyrics;
  let directInput = '';
  let versionsToGenerate;

  if (directMode) {
    directInput = document.getElementById('aiTopic')?.value?.trim() || aiState.musicPrompt || '';
    if (!directInput) {
      showToast(t('toast.aiTopicRequired'), 'warn');
      document.getElementById('aiTopic')?.focus();
      return;
    }
    versionsToGenerate = [{ lyrics: null, label: instrumental ? '纯音乐' : '一句话直出' }];
  } else if (aiState.generatedVersions && aiState.generatedVersions.length >= 2) {
    // AI 生成了 2 个版本 → 全部生成
    versionsToGenerate = aiState.generatedVersions.map(v => ({
      lyrics: v.lyrics,
      label: v.label,
    }));
  } else {
    // 单版本（手动输入或降级）
    let lyrics = document.getElementById('aiLyricsPreviewInput')?.value?.trim();
    if (!lyrics) {
      lyrics = document.getElementById('aiLyrics')?.value?.trim();
    }
    if (!lyrics) { showToast(t('toast.aiLyricsEmpty'), 'warn'); return; }
    const previewEl = document.getElementById('aiLyricsPreviewInput');
    if (previewEl && previewEl.value?.trim() !== lyrics) previewEl.value = lyrics;
    const cleanLyrics = lyrics
      .replace(/^(?:标题|音乐描述|主题)[：:].*$/gm, '').trim()
      .replace(/^[^[]*?(?=\[)/, '').trim()
      .replace(/[\uFFFD]+/g, '').trim();
    if (previewEl && previewEl.value !== cleanLyrics) previewEl.value = cleanLyrics;
    versionsToGenerate = [{ lyrics: cleanLyrics, label: null }];
  }

  aiState.generating = true;
  aiState.abortCtrl = new AbortController();
  // M11：生成带 requestId，取消时通知主进程中止底层计费请求
  aiState.genRequestId = 'ai_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  // 清理结果区上一次的结果
  const resultAreaCard = document.getElementById('aiResultAreaCard');
  if (resultAreaCard) resultAreaCard.style.display = 'none';
  const bottomResultSection = document.getElementById('aiResultSection');
  if (bottomResultSection) bottomResultSection.style.display = 'none';

  // 直出模式没经过"生成歌词"，结果区还折叠着：先展开，否则进度条和成品卡片都看不见
  if (directMode) {
    const aiResultArea = document.getElementById('aiResultArea');
    if (aiResultArea) aiResultArea.style.display = 'block';
  }

  const btnResult = document.getElementById('btnGenMusicResult');
  const btnDirect = document.getElementById('btnGenDirectMusic');
  const resultProgressEl = document.getElementById('aiResultProgress');
  const resultProgressFill = document.getElementById('aiResultProgressFill');
  const resultProgressText = document.getElementById('aiResultProgressText');
  const resultSection = document.getElementById('aiResultSection');

  const setButtonsDisabled = (disabled) => {
    if (btnResult) { btnResult.disabled = disabled; btnResult.textContent = disabled ? '⏳ 生成中...' : '🎶 生成歌曲'; }
    if (btnDirect) { btnDirect.disabled = disabled; btnDirect.textContent = disabled ? '⏳ 生成中...' : '🎶 直接生成歌曲'; }
  };
  const showProgress = (show) => {
    if (resultProgressEl) resultProgressEl.style.display = show ? 'block' : 'none';
  };
  const setProgressWidth = (pct) => {
    if (resultProgressFill) resultProgressFill.style.width = pct;
  };
  const setProgressText = (txt) => {
    if (resultProgressText) resultProgressText.textContent = txt;
  };

  setButtonsDisabled(true);
  showProgress(true);
  if (resultSection) resultSection.style.display = 'none';

  const totalTasks = versionsToGenerate.length;
  const taskLabels = versionsToGenerate.map(v => v.label || '歌曲');
  let progress = 0;
  const startTime = Date.now();
  const timer = setInterval(() => {
    if (progress < 90) {
      const elapsed = (Date.now() - startTime) / 1000;
      progress = Math.min(90, (elapsed / (totalTasks * 180)) * 90);
      setProgressWidth(progress + '%');
    }
  }, 1000);

  try {
    const styleLabel = STYLES.find(s => s.v === document.getElementById('aiStyleValue')?.value)?.l || '流行';
    // 直出模式以用户自己那一句话为准（aiState.musicPrompt 是上一次写词的产物，会串味）
    const musicPrompt = directMode ? directInput : aiState.musicPrompt;
    const title = document.getElementById('aiTitle')?.value?.trim()
      || (directMode ? directInput.slice(0, 20) : 'AI创作');

    // 并行生成所有版本
    setProgressText(`⏳ 正在提交 ${totalTasks} 首任务...`);
    const promises = versionsToGenerate.map((ver) =>
      api.aiGenerateMusic({
        requestId: aiState.genRequestId,
        lyrics: ver.lyrics,
        title,
        musicPrompt,
        style: styleLabel,
        apiKey: aiState.apiKey,
        saveDir: aiState.saveDir || undefined,
        voice: aiState.voice || 'female',
        instrumental,
        autoLyrics,
        model: aiState.model,
      }).then(r => ({ ...r, label: ver.label }))
    );

    const settledResults = await Promise.allSettled(promises);
    clearInterval(timer);

    // 用户已取消：主进程已中止请求，任何残余回包都不再写 UI/历史
    if (aiState.abortCtrl?.signal.aborted) {
      setProgressWidth('0%');
      setProgressText('已取消');
      return;
    }

    // 统计成/败
    const succeeded = [];
    const failed = [];
    settledResults.forEach((sr, i) => {
      const label = taskLabels[i];
      if (sr.status === 'fulfilled' && sr.value.filePath && !sr.value.error) {
        succeeded.push({ ...sr.value, label });
      } else {
        const errMsg = sr.status === 'rejected' ? sr.reason?.message || '请求失败'
          : sr.value?.error || '未知错误';
        failed.push({ label, err: errMsg });
      }
    });

    if (succeeded.length === 0) {
      // 全部失败
      const errList = failed.map(f => `${f.label}: ${f.err}`).join('；');
      showToast(t('toast.aiGenFailed', { msg: errList }), 'error');
      setProgressWidth('0%');
      setProgressText('❌ 全部失败');
      return;
    }

    // 至少有一首成功
    setProgressWidth('100%');
    if (succeeded.length === totalTasks) {
      setProgressText('✅ 全部完成！');
      showToast(t('toast.aiMusicDone', { n: totalTasks }), 'success');
    } else {
      setProgressText(`✅ ${succeeded.length}/${totalTasks} 完成`);
      showToast(t('toast.aiMusicPartial', { ok: succeeded.length, fail: failed.length }), 'warn');
    }

    if (resultSection) resultSection.style.display = 'block';

    // 添加到历史 + 渲染结果
    const resultCardsHtml = succeeded.map((res) => {
      // 添加到历史
      const labelSuffix = res.label ? ` (${res.label})` : '';
      api.aiAddHistory({
        title: title + labelSuffix,
        lyrics: versionsToGenerate.find(v => v.label === res.label)?.lyrics || title,
        style: styleLabel,
        mood: document.getElementById('aiMoodValue')?.value || '',
        audioPath: res.filePath,
      });
      // 与上方 393/394/945 行保持一致：onclick 的 JS 字符串字面量内必须用 escQ。
      // 原为 escAttr —— 它把 ' 转成 &#39;，而内联事件属性会先把实体解码再当 JS 执行，
      // 于是 ' 又变回裸单引号、逃出字符串（AI 生成的音频文件名可含任意字符）。
      const escapedPath = escQ(res.filePath);
      return `<div class="ai-result-card${succeeded.length > 1 ? ' ai-result-card-sm' : ''}">
        <div class="ai-result-icon">🎵</div>
        <div class="ai-result-info">
          <div class="ai-result-title">${esc(title)}</div>
          <div class="ai-result-meta">${res.label ? esc(res.label) + ' · ' : ''}${esc(styleLabel)}</div>
        </div>
        <div class="ai-result-btns">
          <button class="ai-btn-action" onclick="playAiSong('${escapedPath}')">▶ 播放</button>
          <button class="ai-btn-action" onclick="openAiFolder()">📂</button>
        </div>
      </div>`;
    }).join('');

    // 底部栏保留
    document.getElementById('aiResult').innerHTML = resultCardsHtml;
    // 结果区结果卡片
    const areaCard = document.getElementById('aiResultAreaCard');
    if (areaCard) { areaCard.innerHTML = resultCardsHtml; areaCard.style.display = 'block'; }

    // 底部再放一个重新生成按钮
    if (areaCard) {
      const redoBtn = document.createElement('div');
      redoBtn.style.cssText = 'margin-top:10px;text-align:center';
      redoBtn.innerHTML = '<button class="ai-btn-primary" onclick="regenerateAiMusic()">🔄 重新生成全部</button>';
      areaCard.appendChild(redoBtn);
    }

    invalidateAiHistory();
  } catch (e) {
    clearInterval(timer);
    showToast(t('toast.aiGenFailed', { msg: errBrief(e) }), 'error');
    setProgressWidth('0%');
  }
  finally { aiState.generating = false; aiState.abortCtrl = null; setButtonsDisabled(false); showProgress(false); }
}

function cancelAiGeneration() {
  if (aiState.abortCtrl) {
    aiState.abortCtrl.abort();
    // 通知主进程中止底层计费请求（此前取消只改 UI，请求照跑）
    if (typeof api.aiCancelGeneration === 'function') api.aiCancelGeneration(aiState.genRequestId);
    aiState.generating = false;
    showToast(t('toast.aiCanceled'), 'info');
    renderAiMusicPage();
  }
}

function regenerateAiMusic() { generateAiMusic(); }

// ══════════════════════════════════════════════════════════
// 歌词版本切换 + 声线选择
// ══════════════════════════════════════════════════════════

function renderVersionTabs() {
  const container = document.getElementById('aiVersionTabs');
  if (!container) return;
  const versions = aiState.generatedVersions;
  if (!versions || versions.length <= 1) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = versions.map((v, i) =>
    `<button class="ai-version-tab${i === aiState.activeVersion ? ' active' : ''}"
       onclick="selectAiVersion(${i}, this)">${esc(v.label)}</button>`
  ).join('');
}

function selectAiVersion(idx, _btn) {
  aiState.activeVersion = idx;
  // 更新标签高亮
  document.querySelectorAll('#aiVersionTabs .ai-version-tab').forEach((el, n) => {
    el.classList.toggle('active', n === idx);
  });
  // 切换预览区歌词
  const preview = document.getElementById('aiLyricsPreviewInput');
  if (preview && aiState.generatedVersions[idx]) {
    preview.value = aiState.generatedVersions[idx].lyrics;
  }
}

function selectAiVoice(v, _btn) {
  aiState.voice = v;
  // 更新所有声线按钮的高亮
  document.querySelectorAll('[data-voice]').forEach(b => b.classList.toggle('active', b.dataset.voice === v));
}

// 纯音乐 / 一句话直出是两条互斥路径（器乐时"帮你写词"没有意义），
// 所以一次只允许亮一个；高亮与声线行的显隐都跟着 aiState 走。
function toggleAiFlag(key, _btn) {
  const next = aiState[key] !== true;
  aiState.instrumental = key === 'instrumental' ? next : false;
  aiState.autoLyrics = key === 'autoLyrics' ? next : false;
  document.querySelectorAll('[data-flag]').forEach(b =>
    b.classList.toggle('active', aiState[b.dataset.flag] === true));
  const directMode = aiState.instrumental || aiState.autoLyrics;
  const voiceRow = document.getElementById('aiVoiceRow');
  if (voiceRow) voiceRow.style.display = directMode ? 'none' : 'block';
  const lyricsBtn = document.getElementById('btnGenLyrics');
  const directBtn = document.getElementById('btnGenDirectMusic');
  if (lyricsBtn) lyricsBtn.style.display = directMode ? 'none' : '';
  if (directBtn) directBtn.style.display = directMode ? '' : 'none';
}

function selectAiModel(v) {
  aiState.model = v;
}

function playAiSong(filePath) {
  if (typeof loadAndPlay !== 'function') return;
  const song = { title: document.getElementById('aiTitle')?.value || 'AI生成', artist: 'AI创作', filePath };
  // audio error / 25s 加载超时守卫依赖 currentPlaying 真值，缺失会静默卡死
  if (typeof setState === 'function') setState('currentPlaying', song);
  loadAndPlay(song);
}

function openAiFolder() { if (aiState.saveDir) openFolderSafe(aiState.saveDir); }

function showAiLyricsDetail(json) {
  try {
    const lyrics = JSON.parse(json);
    let overlay = document.getElementById('aiLyricsDetailModal');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'aiLyricsDetailModal';
    overlay.className = 'ai-overlay';
    overlay.setAttribute('data-modal', '');
    overlay.setAttribute('data-modal-close', '-');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div class="ai-modal"><div class="ai-modal-header"><span>📝 歌词详情</span><button onclick="document.getElementById('aiLyricsDetailModal').remove()">✕</button></div><div class="ai-modal-body"><pre class="ai-lyrics-detail">${esc(lyrics)}</pre></div></div>`;
    document.body.appendChild(overlay);
  } catch (_e) { showToast(t('toast.aiLoadFailed'), 'error'); }
}

function regenerateFromHistory(json) {
  try {
    const item = JSON.parse(json);
    switchAiTab('create');
    setTimeout(() => {
      if (item.lyrics) {
        const resultArea = document.getElementById('aiResultArea');
        if (resultArea) resultArea.style.display = 'block';
        document.getElementById('aiLyricsPreviewInput').value = item.lyrics;
        document.getElementById('aiLyricsManualMode').style.display = 'none';
      }
      if (item.title) document.getElementById('aiTitle').value = item.title;
      if (item.style) { const btn = document.querySelector(`.ai-chip[data-style="${item.style}"]`); if (btn) selectAiStyle(item.style, btn); }
      if (item.mood) { const btn = document.querySelector(`.ai-chip[data-mood="${item.mood}"]`); if (btn) selectAiMood(item.mood, btn); }
    }, 100);
  } catch (_e) { showToast(t('toast.aiLoadFailed'), 'error'); }
}

function regenerateAiLyrics() {
  generateAiLyrics();
}

// ══════════════════════════════════════════════════════════
// AI 歌单策划
// ══════════════════════════════════════════════════════════

async function generateAiPlaylist() {
  if (!aiState.apiKey) { showToast(t('toast.aiApiKeyMissing'), 'warn'); return; }
  const desc = document.getElementById('aiPlaylistDesc')?.value?.trim();
  if (!desc) { showToast(t('toast.aiPlaylistDescRequired'), 'warn'); document.getElementById('aiPlaylistDesc')?.focus(); return; }

  const count = document.getElementById('aiPlaylistCount')?.value || '10';
  const btn = document.getElementById('btnGenPlaylist');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 生成中...'; }

  try {
    const result = await api.aiGenerateLyrics({
      topic: `为用户生成一个歌单推荐列表。用户描述：${desc}。请推荐 ${count} 首歌曲。`,
      style: 'pop',
      apiKey: aiState.apiKey,
      mode: 'playlist',
    });

    if (result.error) { showToast(t('toast.aiGenFailed', { msg: result.error }), 'error'); return; }

    // 解析歌曲列表
    const lines = (result.lyrics || '').split('\n').filter(l => l.trim());
    const songs = [];
    for (const line of lines) {
      const match = line.match(/^[\d.、]+\s*(.+)/);
      if (match) {
        const parts = match[1].split(/[-—–]/).map(s => s.trim());
        if (parts.length >= 2) {
          songs.push({ title: parts[0], artist: parts[1] });
        } else if (parts.length === 1) {
          songs.push({ title: parts[0], artist: '' });
        }
      }
    }

    if (songs.length === 0) {
      showToast(t('toast.aiPlaylistParsedEmpty'), 'warn');
      return;
    }

    // 显示结果
    aiState.playlistSongs = songs;
    document.getElementById('aiPlaylistResult').style.display = 'block';
    const listEl = document.getElementById('aiPlaylistList');
    listEl.innerHTML = songs.map((s, i) => `
      <div class="ai-playlist-item">
        <span class="ai-playlist-num">${i + 1}</span>
        <span class="ai-playlist-title">${esc(s.title)}</span>
        <span class="ai-playlist-artist">${esc(s.artist)}</span>
        <button class="ai-btn-action" onclick="searchAndAddSong('${escQ(s.title)}','${escQ(s.artist)}')">📥</button>
      </div>
    `).join('');

    showToast(t('toast.aiPlaylistDone', { n: songs.length }), 'success');
  } catch (e) {
    showToast(t('toast.aiGenFailed', { msg: errBrief(e) }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📋 生成歌单'; }
  }
}

async function addAllPlaylistToQueue() {
  if (!aiState.playlistSongs || !aiState.playlistSongs.length) {
    showToast(t('toast.aiNothingToAdd'), 'warn');
    return;
  }

  let added = 0;
  for (const song of aiState.playlistSongs) {
    try {
      const results = await api.searchMusic(song.title, 'all');
      if (results.songs && results.songs.length > 0) {
        await api.addToQueue(results.songs[0]);
        added++;
      }
    } catch (_e) { /* skip */ }
  }

  showToast(t('toast.aiQueueAdded', { n: added }), 'success');
}

async function searchAndAddSong(title, artist) {
  try {
    const results = await api.searchMusic(`${title} ${artist}`, 'all');
    if (results.songs && results.songs.length > 0) {
      await api.addToQueue(results.songs[0]);
      showToast(t('toast.queueAdded', { title }), 'success');
    } else {
      showToast(t('toast.aiNotFound', { title }), 'warn');
    }
  } catch (e) {
    showToast(t('toast.addFailed', { msg: errBrief(e) }), 'error');
  }
}

// ══════════════════════════════════════════════════════════
// 歌词翻译
// ══════════════════════════════════════════════════════════

async function translateLyricsUI() {
  if (!aiState.apiKey) { showToast(t('toast.aiApiKeyMissing'), 'warn'); return; }
  const lyricsEl = document.getElementById('aiLyricsPreviewInput');
  const lyrics = lyricsEl?.value?.trim();
  if (!lyrics) { showToast(t('toast.aiLyricsEmpty'), 'warn'); return; }

  // 显示翻译选项弹窗
  let overlay = document.getElementById('aiTranslateModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'aiTranslateModal';
  overlay.className = 'ai-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="ai-modal">
      <div class="ai-modal-header"><span>🌐 翻译歌词</span><button onclick="document.getElementById('aiTranslateModal').remove()">✕</button></div>
      <div class="ai-modal-body">
        <div class="ai-field-row" style="margin-bottom:16px">
          <label style="min-width:80px">目标语言</label>
          <select class="ai-select" id="aiTranslateTarget" style="flex:1">
            <option value="zh">中文</option>
            <option value="en">英文</option>
            <option value="ja">日文</option>
            <option value="ko">韩文</option>
          </select>
        </div>
        <button class="ai-btn-primary" onclick="executeTranslate()" style="width:100%">🌐 开始翻译</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function executeTranslate() {
  const targetLang = document.getElementById('aiTranslateTarget')?.value || 'zh';
  const lyricsEl = document.getElementById('aiLyricsPreviewInput');
  const lyrics = lyricsEl?.value?.trim();
  if (!lyrics) { showToast(t('toast.aiLyricsEmpty'), 'warn'); return; }

  const overlay = document.getElementById('aiTranslateModal');
  if (overlay) overlay.remove();

  showToast(t('toast.aiTranslating'), 'info');

  try {
    const result = await api.aiTranslateLyrics({
      lyrics,
      targetLang,
      apiKey: aiState.apiKey,
    });

    if (result.error) {
      showToast(t('toast.aiTranslateFailed', { msg: result.error }), 'error');
      return;
    }

    if (result.translated) {
      lyricsEl.value = result.translated;
      showToast(t('toast.aiTranslateDone'), 'success');
    }
  } catch (e) {
    showToast(t('toast.aiTranslateFailed', { msg: errBrief(e) }), 'error');
  }
}

// ══════════════════════════════════════════════════════════
// 历史管理
// ══════════════════════════════════════════════════════════

async function loadAiHistory() {
  if (aiState.historyCache) return aiState.historyCache;
  try { aiState.historyCache = await api.aiGetHistory(); return aiState.historyCache || []; }
  catch { return []; }
}

function invalidateAiHistory() { aiState.historyCache = null; }

async function clearAiHistory() {
  if (!await askConfirm(t('toast.aiHistoryClearConfirm'))) return;
  try {
    await api.aiClearHistory();
  } catch (e) {
    showToast(t('toast.clearFailed', { msg: errBrief(e) }), 'error');
    return;
  }
  aiState.historyCache = null;
  renderAiMusicPage();
  showToast(t('toast.aiHistoryCleared'), 'info');
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function fmtAiDate(d) { if (!d) return ''; const dt = new Date(d); return `${dt.getMonth()+1}/${dt.getDate()} ${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`; }

// 使用全局 esc() 定义在 utils.js 中

// ══════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════

// ── ES Module 导出 ──────────────────────────────────────
export {
  initAiMusic, renderAiMusicPage, switchAiTab,
  selectAiStyle, selectAiMood, switchLyricsMode, toggleAdvanced, clearAiLyrics,
  saveAiApiKey, selectAiSaveDir, generateAiLyrics, generateAiMusic,
  cancelAiGeneration, regenerateAiMusic, regenerateAiLyrics, playAiSong, openAiFolder,
  showAiLyricsDetail, regenerateFromHistory, clearAiHistory,
  translateLyricsUI, executeTranslate,
  generateAiPlaylist, addAllPlaylistToQueue, searchAndAddSong,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
Object.assign(window, {
  initAiMusic, renderAiMusicPage, switchAiTab,
  selectAiStyle, selectAiMood, switchLyricsMode, toggleAdvanced, clearAiLyrics,
  saveAiApiKey, selectAiSaveDir, generateAiLyrics, generateAiMusic,
  cancelAiGeneration, regenerateAiMusic, regenerateAiLyrics, playAiSong, openAiFolder,
  showAiLyricsDetail, regenerateFromHistory, clearAiHistory,
  translateLyricsUI, executeTranslate,
  generateAiPlaylist, addAllPlaylistToQueue, searchAndAddSong,
  selectAiVoice, selectAiVersion, toggleAiFlag, selectAiModel,
});
