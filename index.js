/*
 * 聊天记录自动备份 (Chat Auto Backup) — SillyTavern UI 扩展
 *
 * 需求契约（来自用户）：
 *  1. 记录角色卡聊天记录楼层
 *  2. 达到楼层计数后导出聊天记录
 *  3. 可配置：每 X 楼导出一次
 *  4. 导出文件名：角色卡名称——USER名称——楼层数
 *  5. 不同角色卡之间计数完全隔离，绝不累加
 *  6. 不同角色卡的导出分别创建文件夹保存，不混在一起
 *
 * 实现要点：
 *  - 计数隔离：counter key = `char:<characterId>:<chatId>` 或 `group:<groupId>:<chatId>`，
 *    每个 key 独立记录 lastFloor / exports / lastExportAt。切卡、切换历史聊天互不干扰。
 *  - 楼层定义：与酒馆界面楼号（mesid）一致 = 消息数组索引，0 起；
 *    取最后一条可见（非 is_system）消息的索引，脚本注入的隐藏楼不占楼号。
 *  - 触发判定：floor - lastFloor >= interval 时导出，导出成功后 lastFloor = floor。
 *    首次见到某个 key 时把 lastFloor 初始化为当前楼层（不立刻补导历史）。
 *  - 导出内容：优先走 /api/chats/export（服务端 jsonl 原文 / txt 渲染），失败回退到
 *    前端 context.chat 序列化，保证任何情况下都能出文件。
 *  - 落盘方式：
 *      fsa      —— 用户一次性授权备份根目录（File System Access API），之后静默写入
 *                  <根目录>/<角色卡名>/<角色卡名>——<USER名>——<楼层数>.<格式>，按卡自动建子文件夹。
 *      download —— 浏览器下载（未授权目录或浏览器不支持 FSA 时的回退，文件名带角色卡前缀）。
 *  - 不使用 hooks.activate（保持 minimum_client_version 1.14.0），APP_READY 后自举。
 *  - 角色卡名 / 用户名等所有外部字符串一律经 textContent 注入 DOM，不拼 HTML。
 */

const MODULE_NAME = 'chat-autobackup';
const EXT_VERSION = '1.2.0';
const IDB_NAME = 'chat-autobackup';
const IDB_STORE = 'handles';
const IDB_KEY_ROOT = 'backupRoot';
const SEPARATOR = '——';
const REWRITE_DEBOUNCE_MS = 3500;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,          // 总开关
    interval: 50,           // 每 X 楼导出一次
    format: 'jsonl',        // jsonl | txt
    exportSource: 'local',  // local = 本地直出 Blob（更快，支持精确切片）；server = /api/chats/export
    countMode: 'all',       // all = 用户楼+AI楼都计数；ai = 只在 AI 出楼层后计数
    skipEmptyReply: true,   // 空回拦截：最新楼为空白或空思维链外壳时延后备份
    updateLatestOnRewrite: true, // 在 FSA 模式下重生成/Swipe/编辑当前里程碑楼层时自动原地覆写更新
    writeMode: 'fsa',       // fsa = 写入授权目录（按卡分文件夹）；download = 浏览器下载
    saveBeforeExport: true, // 仅 server 模式生效：导出前先 saveChat，保证服务端 jsonl 是最新的
    toast: true,            // 导出完成提示
    onConflict: 'suffix',   // suffix = 同名追加序号；overwrite = 覆盖
    folderDepth: 'card_chat',        // card_chat = 角色卡/聊天；card = 角色卡；chat = 聊天；none = 平铺
    chatFolderName: 'created',       // created = 角色卡名.聊天创建日期（2026.9.1）；chatid = 聊天文件名；datetime = 导出时间戳
    downloadIncludeChat: true,       // 下载模式下把聊天名并入文件名，避免同卡多聊天混淆
    floorOffset: 0,          // 楼号校准：面板楼号与界面楼号差多少就填多少（界面小 2 就填 -2）
    swallowHidden: 0,        // 切片时最多额外吞并目标楼之后的连续隐藏楼条数（0 = 一个都不带）
    counters: {},           // { [key]: { name, lastFloor, backfilledFloor, exports, lastExportAt, ... } }
    rootName: '',           // 已授权根目录名（仅用于展示）
});

let busy = false;
let pendingRecheck = false;
let rewriteTimer = null;
let rewritePendingKey = '';
let cachedSettingsRef = null;
let cachedDbPromise = null;
let cachedRootHandle = undefined; // undefined = 未读取；null = 无句柄
let refreshRafId = 0;
let panelDirty = false;
let searchDebounceTimer = null;

const uiState = {
    activeTab: 'overview',
    searchQuery: '',
    backingUp: false,
    backfillProgress: null, // { current, total } | null
    deferredReason: '',     // 非空表示当前处于空回延后状态
    deferredKey: '',
    rewritePending: false,
};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function ctx() {
    const context = window.SillyTavern?.getContext?.();
    if (!context) throw new Error(`[${MODULE_NAME}] SillyTavern context 不可用`);
    return context;
}

function log(...args) {
    console.debug(`[${MODULE_NAME}]`, ...args);
}

function settings() {
    const context = ctx();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS, counters: {} };
    }
    const s = context.extensionSettings[MODULE_NAME];
    if (s !== cachedSettingsRef) {
        // 仅在初始化或外部替换设置对象引用时补齐新增字段，避免高频重复遍历
        for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
            if (s[k] === undefined) s[k] = (k === 'counters') ? {} : v;
        }
        if (!s.counters || typeof s.counters !== 'object') s.counters = {};
        cachedSettingsRef = s;
    }
    return s;
}

function saveSettings() {
    try {
        ctx().saveSettingsDebounced?.();
    } catch (e) {
        log('saveSettings failed', e);
    }
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\r\n\t]/g;

function safeFileName(input) {
    return String(input ?? '')
        .replace(ILLEGAL_FILENAME_CHARS, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
        .slice(0, 80) || 'unnamed';
}

function notify(message, type = 'info') {
    if (!settings().toast) return;
    try {
        window.toastr?.[type]?.(message);
    } catch (e) {
        log('toast failed', e);
    }
}

function timestampSlug(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/* ------------------------------------------------------------------ *
 * 上下文读取：角色卡名 / USER 名 / 楼层 / 计数 key
 * ------------------------------------------------------------------ */

function currentIdentity(includeHidden = true) {
    const context = ctx();
    const isGroup = Boolean(context.groupId);
    const chatId = context.getCurrentChatId?.() ?? '';
    let entityId = '';
    let cardName = '';

    if (isGroup) {
        entityId = String(context.groupId);
        cardName = context.groups?.find((g) => String(g.id) === String(context.groupId))?.name || '群聊';
    } else {
        entityId = String(context.characterId ?? '');
        cardName = context.characters?.[context.characterId]?.name || context.name2 || '角色卡';
    }

    const userName = context.name1 || 'USER';
    // 楼层标准：与酒馆界面楼号（mesid）一致 = 最后一条消息的数组索引。
    // 依据：redisplayChat 对全部消息渲染并赋 mesid = 数组下标，is_system 楼同样占楼号，
    // 且 ST 核心 CSS 无任何隐藏 [is_system] 的规则 → 隐藏楼就是真实楼层。
    // 若你的界面显示仍与面板差 N 楼，用设置项「楼号校准」填 -N 即可，无需改代码。
    const total = Array.isArray(context.chat) ? context.chat.length : 0;
    const hidden = includeHidden ? countHidden(context.chat) : null;
    const floor = Math.max(0, (total - 1) + (Number(settings().floorOffset) || 0));
    const key = `${isGroup ? 'group' : 'char'}:${entityId}:${chatId}`;

    return { isGroup, chatId, entityId, cardName, userName, floor, key, total, hidden };
}

/** 统计隐藏楼（is_system）条数，仅用于面板展示与诊断。 */
function countHidden(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (m?.is_system) n += 1;
    return n;
}

/** 剥离纯空白思维链空壳与 HTML 注释，判断消息是否属于“空回”。 */
function isMessageEmpty(msg) {
    if (!msg) return true;
    const hasMedia = Array.isArray(msg.extra?.media) && msg.extra.media.length > 0;
    if (hasMedia) return false;

    const raw = String(msg.extra?.display_text ?? msg.mes ?? '');
    if (!raw.trim()) return true;

    const stripped = raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(think|thinking)\b[^>]*>\s*<\/\1>/gi, '')
        .replace(/^\s*<(think|thinking)\b[^>]*>\s*$/gim, '')
        .trim();
    return stripped.length === 0;
}

/** 快速 FNV-1a 32位哈希，避免把整条消息文本存进 settings。 */
function fastHash32(str) {
    let hash = 0x811c9dc5;
    const text = String(str ?? '');
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

/** 计算单条消息的内容指纹（包含当前正文、swipe_id 与 swipes 数量）。 */
function messageFingerprint(msg) {
    if (!msg) return '';
    const mes = String(msg.mes ?? '');
    const display = msg.extra?.display_text !== undefined ? String(msg.extra.display_text) : '';
    const swipeId = msg.swipe_id ?? '';
    const swipesLen = Array.isArray(msg.swipes) ? msg.swipes.length : 0;
    return `${swipeId}:${swipesLen}:${mes.length}:${fastHash32(mes)}:${display ? fastHash32(display) : ''}`;
}

/** 获取指定楼号之前（含）最近一条非隐藏消息下标；找不到则回退 rawIndex。 */
function resolveWatchIndex(messages, floor, floorOffset = Number(settings().floorOffset) || 0) {
    if (!Array.isArray(messages) || messages.length === 0) return -1;
    const raw = Math.max(0, Math.min(messages.length - 1, Number(floor) - floorOffset));
    for (let i = raw; i >= 0; i -= 1) {
        if (!messages[i]?.is_system) return i;
    }
    return raw;
}

/**
 * 切片终点：截止到界面楼号 target（含）=> 结合 floorOffset 换算数组索引 [0, rawIndex + 1)。
 * 可选向后吞并紧随的隐藏楼，但有硬上限（默认 0，绝不吞并）：
 * 星光旅途这类 MVU 卡会连续注入上百条隐藏楼，无上限吞并会把 50 楼的切片膨胀成整档。
 */
function sliceEnd(messages, target, offset = Number(settings().floorOffset) || 0) {
    const len = Array.isArray(messages) ? messages.length : 0;
    if (len === 0) return { end: 0, swallowed: 0 };
    const cap = Math.max(0, Math.min(50, Number(settings().swallowHidden) || 0));
    const rawTarget = Number(target) - offset;
    let end = Math.max(0, Math.min(rawTarget + 1, len));
    let swallowed = 0;
    while (end < len && messages[end]?.is_system && swallowed < cap) {
        end += 1;
        swallowed += 1;
    }
    return { end, swallowed };
}

/**
 * 聊天创建日期：优先取首楼 send_date（ISO 8601），回退到聊天文件名里的日期，
 * 再回退到今天。输出格式 2026.9.1（年.月.日，无前导零）。
 */
function chatCreatedDateSlug(identity) {
    try {
        const first = ctx().chat?.[0];
        if (first?.send_date) {
            const date = new Date(first.send_date);
            if (!Number.isNaN(date.getTime())) {
                return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
            }
        }
    } catch (e) {
        log('读取首楼时间失败', e);
    }

    const match = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(identity?.chatId ?? ''));
    if (match) {
        return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
    }

    const now = new Date();
    return `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
}

/** 聊天文件夹名：默认「角色卡名.创建日期」，例如 星野光.2026.9.1 */
function chatFolderName(identity, s = settings()) {
    switch (s.chatFolderName) {
        case 'datetime':
            return timestampSlug();
        case 'chatid':
            return safeFileName(identity.chatId || 'chat');
        case 'created':
        default:
            return `${safeFileName(identity.cardName)}.${chatCreatedDateSlug(identity)}`;
    }
}

/**
 * 备份目录层级：默认 <根目录>/<角色卡>/<聊天>，
 * 保证同一角色卡的不同聊天记录各占一个文件夹，互不覆盖。
 */
function backupPathSegments(identity) {
    const s = settings();
    const chatFolder = chatFolderName(identity, s);
    switch (s.folderDepth) {
        case 'card':
            return [safeFileName(identity.cardName)];
        case 'chat':
            return [chatFolder];
        case 'none':
            return [];
        case 'card_chat':
        default:
            return [safeFileName(identity.cardName), chatFolder];
    }
}

/** 目录模式严格使用「角色卡名称——USER名称——楼层数」；下载模式可并入聊天名防混淆 */
function buildFileName(identity, format, forDownload = false, floor = null) {
    const parts = [safeFileName(identity.cardName)];
    if (forDownload && settings().downloadIncludeChat && identity.chatId) {
        parts.push(safeFileName(identity.chatId));
    }
    parts.push(safeFileName(identity.userName));
    parts.push(String(floor ?? identity.floor));
    return `${parts.join(SEPARATOR)}.${format}`;
}

function getCounter(key) {
    const s = settings();
    if (!s.counters[key]) {
        s.counters[key] = {
            name: '',
            lastFloor: 0,
            backfilledFloor: 0,
            exports: 0,
            lastExportAt: '',
            initialized: false,
            lastBackupFile: '',
            lastBackupFp: '',
            lastBackupWatchIndex: -1,
            lastBackupFormat: '',
            lastBackupSegments: [],
        };
    }
    if (s.counters[key].backfilledFloor === undefined) s.counters[key].backfilledFloor = 0;
    return s.counters[key];
}

function clearCounterRewriteMeta(counter) {
    if (!counter) return;
    counter.lastBackupFile = '';
    counter.lastBackupFp = '';
    counter.lastBackupWatchIndex = -1;
    counter.lastBackupFormat = '';
    counter.lastBackupSegments = [];
}

/** 只读读取计数记录，避免仅仅刷新面板时污染 counters 字典 */
function peekCounter(key) {
    const c = settings().counters?.[key];
    if (!c) {
        return { name: '', lastFloor: 0, backfilledFloor: 0, exports: 0, lastExportAt: '', _exists: false };
    }
    return {
        name: c.name || '',
        lastFloor: Number(c.lastFloor ?? 0),
        backfilledFloor: Number(c.backfilledFloor ?? 0),
        exports: Number(c.exports ?? 0),
        lastExportAt: c.lastExportAt || '',
        lastBackupFile: c.lastBackupFile || '',
        lastBackupFp: c.lastBackupFp || '',
        lastBackupWatchIndex: Number(c.lastBackupWatchIndex ?? -1),
        lastBackupFormat: c.lastBackupFormat || '',
        lastBackupSegments: Array.isArray(c.lastBackupSegments) ? c.lastBackupSegments : [],
        _exists: true,
    };
}

function hasActiveChat(identity) {
    return Boolean(identity && (identity.chatId || identity.total > 0));
}

function parseTimestampSlug(slug) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(slug ?? '').trim());
    if (!m) return null;
    return {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: m[4],
        minute: m[5],
        second: m[6],
        full: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    };
}

function getNowDateParts(now = new Date()) {
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        yYear: yest.getFullYear(),
        yMonth: yest.getMonth() + 1,
        yDay: yest.getDate(),
    };
}

/** 把 YYYYMMDD-HHmmss 格式化为更易读的时间，保留完整时间供 tooltip 展示 */
function formatReadableTime(slug, { compact = false, nowParts = null } = {}) {
    if (!slug) return { text: '尚未导出', full: '' };
    const p = parseTimestampSlug(slug);
    if (!p) return { text: String(slug), full: String(slug) };
    const d = nowParts || getNowDateParts();
    const sameYear = d.year === p.year;
    const sameDay = sameYear && d.month === p.month && d.day === p.day;
    const isYesterday = d.yYear === p.year && d.yMonth === p.month && d.yDay === p.day;
    const mm = String(p.month).padStart(2, '0');
    const dd = String(p.day).padStart(2, '0');

    if (sameDay) return { text: `今天 ${p.hour}:${p.minute}`, full: p.full };
    if (isYesterday) return { text: `昨天 ${p.hour}:${p.minute}`, full: p.full };
    if (sameYear) return { text: `${mm}-${dd} ${p.hour}:${p.minute}`, full: p.full };
    return {
        text: compact ? `${p.year}-${mm}-${dd}` : `${p.year}-${mm}-${dd} ${p.hour}:${p.minute}`,
        full: p.full,
    };
}

/**
 * 清理冗长的酒馆聊天 ID：去掉与角色卡名重复的前缀，美化 @HHhMMmSSsNNNms 时间戳，
 * 并提取 imported 标记；原始 chatId 仍保留在 raw 字段供悬停查看。
 */
function formatChatSession(chatId, cardName = '') {
    const raw = String(chatId ?? '').trim();
    if (!raw) return { label: '未命名会话', imported: false, raw: '' };

    let text = raw;
    const prefix = cardName ? `${cardName} - ` : '';
    if (prefix && text.startsWith(prefix)) {
        text = text.slice(prefix.length).trim();
    }

    let imported = false;
    if (/\s+imported$/i.test(text)) {
        imported = true;
        text = text.replace(/\s+imported$/i, '').trim();
    }

    text = text.replace(
        /(\d{4}-\d{2}-\d{2})@(\d{2})h(\d{2})m\d{2}s(?:\d+ms)?/g,
        '$1 $2:$3',
    );

    return { label: text || raw, imported, raw };
}

function intervalValue(s = settings()) {
    return Math.max(1, parseInt(s.interval, 10) || 1);
}

/**
 * 楼层推进后的判定：返回是否需要导出。
 * 首次见到该 key：基线对齐到「当前楼层向下取整的间隔倍数」（例：438 楼 / 间隔 50 → 400），
 * 既不立刻补历史、也不会一到插件就狂导出；历史段落留给「回溯备份」手动补齐。
 */
function shouldExport(identity) {
    const s = settings();
    const existed = Boolean(s.counters?.[identity.key]);
    const counter = getCounter(identity.key);
    const interval = intervalValue(s);
    const isFirstSeen = !existed || (!counter.initialized && !counter.lastFloor && counter.exports === 0 && !counter.lastExportAt);

    if (isFirstSeen) {
        counter.lastFloor = Math.floor(identity.floor / interval) * interval;
        counter.name = identity.cardName;
        counter.initialized = true;
        saveSettings();
        log(`初始化计数基线 key=${identity.key} floor=${identity.floor} → 基线 ${counter.lastFloor}`);
        return false;
    }
    if (!counter.initialized) counter.initialized = true;

    // 聊天被回退/删楼层：基线按间隔重新对齐到不高于当前楼层的倍数，避免后续备份点永久偏移
    if (identity.floor < counter.lastFloor) {
        const aligned = Math.floor(identity.floor / interval) * interval;
        if (counter.lastFloor !== aligned) {
            counter.lastFloor = aligned;
            if ((counter.backfilledFloor ?? 0) > aligned) {
                counter.backfilledFloor = aligned;
            }
            clearCounterRewriteMeta(counter);
            saveSettings();
            log(`检测到删楼回退，基线重对齐 key=${identity.key} floor=${identity.floor} → 基线 ${aligned}`);
        }
        return false;
    }

    return (identity.floor - counter.lastFloor) >= interval;
}

/**
 * 待回溯的历史段落：从「已回溯楼层」往上一个间隔开始，到「当前楼层向下取整的间隔倍数」为止。
 * 例：当前 438 楼、间隔 50、从未回溯 → [50, 100, 150, 200, 250, 300, 350, 400]
 * 例：已回溯到 300 楼、当前 438 楼 → [350, 400]
 */
function pendingSegments(identity, s = settings()) {
    const interval = intervalValue(s);
    const counter = peekCounter(identity.key);
    const base = Number(counter.backfilledFloor ?? 0);
    const lastFull = Math.floor(identity.floor / interval) * interval;
    const segments = [];
    for (let target = Math.ceil((base + 1) / interval) * interval; target <= lastFull; target += interval) {
        segments.push(target);
    }
    return segments;
}

/** 段落列表的可读摘要：1 段：50；多段：50 / 100 / … / 400 */
function formatSegments(segments, maxShown = 8) {
    if (!Array.isArray(segments) || !segments.length) return '无';
    if (segments.length <= maxShown) return segments.join(' / ');
    return `${segments.slice(0, 3).join(' / ')} … ${segments.slice(-2).join(' / ')}（共 ${segments.length} 段）`;
}

function baselineFloor(identity, s = settings()) {
    const counter = peekCounter(identity.key);
    const interval = intervalValue(s);
    const isUnseen = !counter._exists && !counter.lastFloor && !counter.exports && !counter.lastExportAt;
    if (isUnseen) {
        return Math.floor(identity.floor / interval) * interval;
    }
    return Math.min(identity.floor, Number(counter.lastFloor ?? 0));
}

function remainingFloors(identity) {
    const s = settings();
    const interval = intervalValue(s);
    const base = baselineFloor(identity, s);
    return Math.max(0, interval - Math.max(0, identity.floor - base));
}

/* ------------------------------------------------------------------ *
 * 导出内容：本地直出 Blob / 服务端 /api/chats/export
 * ------------------------------------------------------------------ */

async function fetchServerExport(format) {
    const context = ctx();
    if (settings().saveBeforeExport) {
        try {
            await context.saveChat?.();
        } catch (e) {
            log('saveChat before export failed', e);
        }
    }

    const isGroup = Boolean(context.groupId);
    const chatId = context.getCurrentChatId?.();
    if (!chatId) throw new Error('无法获取当前聊天 ID');

    const body = {
        is_group: isGroup,
        avatar_url: isGroup ? null : (context.characters?.[context.characterId]?.avatar ?? null),
        file: `${chatId}.jsonl`,
        exportfilename: `${chatId}.${format}`,
        format,
    };

    const response = await fetch('/api/chats/export', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || typeof data.result !== 'string') {
        throw new Error(data?.message || `导出接口返回 ${response.status}`);
    }
    return data.result;
}

/**
 * jsonl 元数据表头行。
 * 必要原因（已查 src/endpoints/chats.js /api/chats/import）：
 *   - 导入时以首行为表头校验并原样拷贝，加载时又被 data.shift() 剥离
 *   - 内存里的 context.chat 不含元数据（加载时已剥掉），直接序列化会导致
 *     首条消息被当成表头吃掉 → 回导入后整体少一条、楼层号全部 -1
 * 结构对齐酒馆原生导出：{ user_name, character_name, chat_metadata }
 */
function buildHeaderLine(identity) {
    const context = ctx();
    const meta = (context.chatMetadata && typeof context.chatMetadata === 'object') ? context.chatMetadata : {};
    return JSON.stringify({
        user_name: identity?.userName ?? '',
        character_name: identity?.cardName ?? '',
        chat_metadata: meta,
    });
}

function formatTxtMessage(m) {
    return `${m?.name ?? '?'}: ${String(m?.extra?.display_text ?? m?.mes ?? '').replace(/\r?\n/g, '\n')}`;
}

/**
 * 分块序列化当前聊天（避免大聊天反复整串拼接导致内存峰值翻倍）。
 * @param {string} format jsonl | txt
 * @param {number|null} uptoFloor 截止的界面楼号（含该楼）。null = 整档。
 */
function serializeLocalChatParts(format, uptoFloor = null, identity = null) {
    const context = ctx();
    const all = Array.isArray(context.chat) ? context.chat : [];
    const end = uptoFloor === null ? all.length : sliceEnd(all, uptoFloor).end;

    if (format === 'txt') {
        const parts = [];
        let first = true;
        for (let i = 0; i < end; i += 1) {
            const m = all[i];
            if (m?.is_system) continue;
            if (!first) parts.push('\n\n');
            parts.push(formatTxtMessage(m));
            first = false;
        }
        parts.push('\n');
        return parts;
    }

    const header = buildHeaderLine(identity ?? currentIdentity(false));
    const parts = [header, '\n'];
    if (end === 0) {
        parts.push('\n');
        return parts;
    }
    for (let i = 0; i < end; i += 1) {
        parts.push(JSON.stringify(all[i]), '\n');
    }
    return parts;
}

/**
 * 序列化当前聊天为单个字符串（保留兼容）。
 */
function serializeLocalChat(format, uptoFloor = null, identity = null) {
    return serializeLocalChatParts(format, uptoFloor, identity).join('');
}

function partsToBlob(parts, format) {
    const type = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/jsonl;charset=utf-8';
    return new Blob(parts, { type });
}

async function buildExportContent(format, { uptoFloor = null, identity = null } = {}) {
    const s = settings();
    const id = identity ?? currentIdentity(false);
    const mustSlice = uptoFloor !== null;
    const preferLocal = mustSlice || (s.exportSource === 'local' && format === 'jsonl');

    if (preferLocal) {
        const parts = serializeLocalChatParts(format, uptoFloor, id);
        return { content: partsToBlob(parts, format), source: 'local-direct' };
    }

    try {
        return { content: await fetchServerExport(format), source: 'server' };
    } catch (e) {
        log('服务端导出失败，回退本地序列化', e);
        const parts = serializeLocalChatParts(format, uptoFloor, id);
        return { content: partsToBlob(parts, format), source: 'local-fallback' };
    }
}

/* ------------------------------------------------------------------ *
 * 落盘：File System Access API（按角色卡分文件夹） / 浏览器下载回退
 * ------------------------------------------------------------------ */

function openDb() {
    if (cachedDbPromise) return cachedDbPromise;
    cachedDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onclose = () => { cachedDbPromise = null; };
            resolve(db);
        };
        request.onerror = () => {
            cachedDbPromise = null;
            reject(request.error);
        };
    });
    return cachedDbPromise;
}

async function idbGet(key) {
    try {
        const db = await openDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        log('idbGet failed', e);
        return null;
    }
}

async function idbSet(key, value) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return true;
    } catch (e) {
        log('idbSet failed', e);
        return false;
    }
}

async function idbDelete(key) {
    try {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return true;
    } catch (e) {
        log('idbDelete failed', e);
        return false;
    }
}

function fsaSupported() {
    return typeof window.showDirectoryPicker === 'function';
}

async function pickBackupRoot() {
    if (!fsaSupported()) {
        notify('当前浏览器不支持目录授权，请改用「浏览器下载」模式', 'warning');
        return null;
    }
    const handle = await window.showDirectoryPicker({ id: MODULE_NAME, mode: 'readwrite' });
    cachedRootHandle = handle;
    await idbSet(IDB_KEY_ROOT, handle);
    settings().rootName = handle.name || '已授权目录';
    saveSettings();
    scheduleRefresh({ force: true });
    return handle;
}

async function getRootHandle() {
    if (cachedRootHandle !== undefined) return cachedRootHandle;
    const handle = await idbGet(IDB_KEY_ROOT);
    cachedRootHandle = handle || null;
    return cachedRootHandle;
}

async function ensurePermission(handle) {
    if (!handle) return false;
    try {
        let permission = await handle.queryPermission?.({ mode: 'readwrite' });
        if (permission !== 'granted') {
            permission = await handle.requestPermission?.({ mode: 'readwrite' });
        }
        return permission === 'granted';
    } catch (e) {
        log('requestPermission failed', e);
        return false;
    }
}

async function resolveDirectory(handle, segments) {
    let dir = handle;
    for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    return dir;
}

async function listExistingFileNames(dir) {
    const names = new Set();
    if (typeof dir?.keys === 'function') {
        for await (const name of dir.keys()) {
            names.add(name);
        }
    }
    return names;
}

/**
 * 写入 <根目录>/<角色卡文件夹>/<文件名>
 * 支持传入已解析的 dirHandle、existingNames（批量回溯免重复 IPC）与 overwriteExact（原地覆写）。
 */
async function writeViaFsa(handle, segments, fileName, content, options = {}) {
    const {
        dirHandle = null,
        existingNames = null,
        overwriteExact = false,
        skipPermissionCheck = false,
    } = options;

    if (!skipPermissionCheck && !(await ensurePermission(handle))) {
        throw new Error('FSA_PERMISSION_DENIED');
    }

    const dir = dirHandle || await resolveDirectory(handle, segments);

    let target = fileName;
    if (!overwriteExact && settings().onConflict === 'suffix') {
        let index = 1;
        if (existingNames instanceof Set) {
            while (existingNames.has(target)) {
                index += 1;
                target = withSuffix(fileName, index);
            }
        } else {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                let exists = false;
                try {
                    await dir.getFileHandle(target, { create: false });
                    exists = true;
                } catch (e) {
                    exists = false;
                }
                if (!exists) break;
                index += 1;
                target = withSuffix(fileName, index);
            }
        }
    }

    const fileHandle = await dir.getFileHandle(target, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    if (existingNames instanceof Set) existingNames.add(target);
    return target;
}

function withSuffix(fileName, index) {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return `${fileName} (${index})`;
    return `${fileName.slice(0, dot)} (${index})${fileName.slice(dot)}`;
}

function writeViaDownload(fileName, content, format, { revokeDelayMs = 1500 } = {}) {
    const type = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/jsonl;charset=utf-8';
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
    return fileName;
}

/* ------------------------------------------------------------------ *
 * 备份主流程 & 里程碑覆写/定稿
 * ------------------------------------------------------------------ */

function cancelPendingRewrite() {
    if (rewriteTimer) {
        clearTimeout(rewriteTimer);
        rewriteTimer = null;
    }
    if (uiState.rewritePending || rewritePendingKey) {
        uiState.rewritePending = false;
        rewritePendingKey = '';
    }
}

async function runBackup({
    manual = false,
    targetFloor = null,
    overwriteFile = null,
    targetSegments = null,
    formatOverride = null,
    reasonLabel = '',
} = {}) {
    if (busy) {
        if (!manual && !overwriteFile) pendingRecheck = true;
        log('上一次备份尚未结束，跳过本次触发');
        return { ok: false, reason: 'busy' };
    }
    busy = true;
    uiState.backingUp = true;
    syncBusyUI();
    try {
        const s = settings();
        const identity = currentIdentity(false);
        const backupFloor = targetFloor !== null ? Number(targetFloor) : identity.floor;
        const format = formatOverride || (s.format === 'txt' ? 'txt' : 'jsonl');
        const dirFileName = overwriteFile || buildFileName(identity, format, false, backupFloor);
        const downloadName = buildFileName(identity, format, true, backupFloor);
        const segments = Array.isArray(targetSegments) ? targetSegments : backupPathSegments(identity);
        const isRewrite = Boolean(overwriteFile);

        const { content, source } = await buildExportContent(format, {
            uptoFloor: targetFloor,
            identity,
        });

        let savedAs = downloadName;
        let mode = 'download';

        if (s.writeMode === 'fsa' && fsaSupported()) {
            const handle = await getRootHandle();
            if (handle) {
                try {
                    savedAs = await writeViaFsa(handle, segments, dirFileName, content, {
                        overwriteExact: isRewrite,
                    });
                    mode = 'fsa';
                } catch (e) {
                    if (isRewrite) {
                        log('FSA 原地覆写失败，跳过回退下载以免重复弹窗', e);
                        return { ok: false, reason: e?.message || String(e) };
                    }
                    log('FSA 写入失败，回退浏览器下载', e);
                    savedAs = writeViaDownload(downloadName, content, format);
                    mode = 'download';
                }
            } else {
                if (isRewrite) return { ok: false, reason: 'no_handle' };
                savedAs = writeViaDownload(downloadName, content, format);
            }
        } else {
            if (isRewrite) return { ok: false, reason: 'not_fsa' };
            savedAs = writeViaDownload(downloadName, content, format);
        }

        const counter = getCounter(identity.key);
        const messages = Array.isArray(ctx().chat) ? ctx().chat : [];
        const watchIndex = resolveWatchIndex(messages, backupFloor, Number(s.floorOffset) || 0);
        const watchFp = watchIndex >= 0 ? messageFingerprint(messages[watchIndex]) : '';

        counter.name = identity.cardName;
        counter.initialized = true;
        if (!isRewrite) {
            counter.lastFloor = backupFloor;
            counter.exports = (counter.exports || 0) + 1;
            if (!manual) {
                const interval = intervalValue(s);
                const aligned = Math.floor(backupFloor / interval) * interval;
                const prevAligned = Math.max(0, aligned - interval);
                if ((counter.backfilledFloor ?? 0) >= prevAligned && aligned > (counter.backfilledFloor ?? 0)) {
                    counter.backfilledFloor = aligned;
                }
            }
        }
        counter.lastExportAt = timestampSlug();

        if (mode === 'fsa') {
            counter.lastBackupFile = savedAs;
            counter.lastBackupSegments = segments;
            counter.lastBackupFormat = format;
            counter.lastBackupFp = watchFp;
            counter.lastBackupWatchIndex = watchIndex;
        } else if (!isRewrite) {
            clearCounterRewriteMeta(counter);
        }

        if (uiState.deferredKey === identity.key) {
            uiState.deferredReason = '';
            uiState.deferredKey = '';
        }
        if (rewritePendingKey === identity.key) {
            uiState.rewritePending = false;
            rewritePendingKey = '';
        }

        saveSettings();

        const place = mode === 'fsa'
            ? [s.rootName || '备份根目录', ...segments].join('\\') + '\\'
            : '浏览器下载目录';
        const sourceNote = source === 'local-fallback' ? '（本地序列化回退）' : '';
        const message = isRewrite
            ? `已更新第 ${backupFloor} 楼备份${reasonLabel ? `（${reasonLabel}）` : ''} → ${place}${savedAs}`
            : `已备份 ${identity.cardName} 第 ${backupFloor} 楼 → ${place}${savedAs}${sourceNote}`;
        log(message);
        notify(manual ? `手动备份完成：${savedAs}` : message, 'success');
        scheduleRefresh({ force: true });
        return { ok: true, mode, savedAs, identity, isRewrite };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 备份失败`, e);
        notify(`备份失败：${e?.message || e}`, 'error');
        return { ok: false, reason: e?.message || String(e) };
    } finally {
        busy = false;
        uiState.backingUp = false;
        syncBusyUI();
        if (pendingRecheck) {
            pendingRecheck = false;
            setTimeout(() => onChatActivity('recheck'), 0);
        }
    }
}

async function tryOverwriteMilestone(identity, counter, reasonLabel = '重生成更新') {
    const s = settings();
    if (!s.enabled || !s.updateLatestOnRewrite) return false;
    if (s.writeMode !== 'fsa' || !fsaSupported()) return false;
    if (!counter?.lastBackupFile || Number(counter.lastBackupWatchIndex ?? -1) < 0) return false;

    const messages = Array.isArray(ctx().chat) ? ctx().chat : [];
    const watchIdx = Number(counter.lastBackupWatchIndex);
    const targetMsg = messages[watchIdx];
    if (!targetMsg) return false;

    // 切到新的空回或重生成空回时，绝不用空内容覆盖已存好的有效文件
    if (s.skipEmptyReply && isMessageEmpty(targetMsg)) {
        log(`第 ${counter.lastFloor} 楼当前内容为空，跳过原地覆写以保护已有备份`);
        return false;
    }

    const newFp = messageFingerprint(targetMsg);
    if (newFp === counter.lastBackupFp) return false;

    const result = await runBackup({
        manual: false,
        targetFloor: counter.lastFloor,
        overwriteFile: counter.lastBackupFile,
        targetSegments: counter.lastBackupSegments,
        formatOverride: counter.lastBackupFormat || undefined,
        reasonLabel,
    });
    return Boolean(result?.ok);
}

function scheduleMilestoneRewrite(identity, reasonLabel = '重生成/Swipe 更新') {
    const s = settings();
    if (!s.enabled || !s.updateLatestOnRewrite || s.writeMode !== 'fsa' || !fsaSupported()) return;

    const counter = peekCounter(identity.key);
    if (!counter._exists || !counter.lastBackupFile || counter.lastFloor !== identity.floor) return;

    const messages = Array.isArray(ctx().chat) ? ctx().chat : [];
    const targetMsg = messages[counter.lastBackupWatchIndex];
    if (!targetMsg) return;
    if (s.skipEmptyReply && isMessageEmpty(targetMsg)) return;
    if (messageFingerprint(targetMsg) === counter.lastBackupFp) return;

    cancelPendingRewrite();
    rewritePendingKey = identity.key;
    uiState.rewritePending = true;
    scheduleRefresh();

    rewriteTimer = setTimeout(async () => {
        rewriteTimer = null;
        uiState.rewritePending = false;
        rewritePendingKey = '';
        try {
            const cur = currentIdentity(false);
            if (cur.key !== identity.key) return;
            const liveCounter = getCounter(cur.key);
            if (cur.floor !== liveCounter.lastFloor) return;
            await tryOverwriteMilestone(cur, liveCounter, reasonLabel);
        } catch (e) {
            log('防抖覆写备份失败', e);
        } finally {
            scheduleRefresh();
        }
    }, REWRITE_DEBOUNCE_MS);
}

function yieldToMain() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 回溯备份：按导出间隔把「已加载的历史楼层」逐段补齐。
 * 优化：使用 O(N) 增量序列化与 Blob 分块写入，避免 O(K²·N) 重复序列化和主线程长阻塞。
 */
async function runBackfill() {
    if (busy) {
        notify('上一次备份尚未结束，请稍候', 'warning');
        return { ok: false, reason: 'busy' };
    }

    const s = settings();
    let identity;
    try {
        identity = currentIdentity(false);
    } catch (e) {
        notify(`读取当前聊天失败：${e?.message || e}`, 'error');
        return { ok: false, reason: e?.message || String(e) };
    }

    const floors = pendingSegments(identity, s);
    if (!floors.length) {
        notify('没有待回溯的历史段落（历史已补齐，或当前楼层不足一个间隔）', 'info');
        return { ok: true, done: 0 };
    }

    if (floors.length > 60) {
        const ok = window.confirm(
            `将按 ${intervalValue(s)} 楼的间隔生成 ${floors.length} 个备份文件（${floors[0]} → ${floors[floors.length - 1]}）。\n` +
            '文件数量较多，建议先把导出间隔调大。确定继续？',
        );
        if (!ok) return { ok: false, reason: 'cancelled' };
    }

    busy = true;
    uiState.backfillProgress = { current: 0, total: floors.length };
    syncBusyUI(floors);
    const format = s.format === 'txt' ? 'txt' : 'jsonl';
    const pathSegments = backupPathSegments(identity);
    const offset = Number(s.floorOffset) || 0;
    const swallowCap = Math.max(0, Math.min(50, Number(s.swallowHidden) || 0));

    let handle = null;
    let dirHandle = null;
    let existingNames = null;
    if (s.writeMode === 'fsa' && fsaSupported()) {
        handle = await getRootHandle();
        if (handle) {
            if (await ensurePermission(handle)) {
                try {
                    dirHandle = await resolveDirectory(handle, pathSegments);
                    if (s.onConflict === 'suffix') {
                        existingNames = await listExistingFileNames(dirHandle);
                    }
                } catch (e) {
                    log('回溯：预解析 FSA 目录失败，将回退下载', e);
                    handle = null;
                    dirHandle = null;
                }
            } else {
                handle = null;
            }
        }
    }

    let done = 0;
    let lastOk = Number(getCounter(identity.key).backfilledFloor ?? 0);
    const written = [];

    // 增量序列化状态（每条消息仅序列化 1 次）
    const headerLine = format === 'jsonl' ? buildHeaderLine(identity) : '';
    const parts = format === 'jsonl' ? [headerLine, '\n'] : [];
    let cachedEnd = 0;
    let totalChars = headerLine ? headerLine.length + 1 : 0;
    let txtHasItem = false;

    try {
        for (let segIdx = 0; segIdx < floors.length; segIdx += 1) {
            const target = floors[segIdx];
            uiState.backfillProgress = { current: done + 1, total: floors.length };
            syncBusyUI(floors);
            try {
                const all = Array.isArray(ctx().chat) ? ctx().chat : [];
                const { end } = sliceEnd(all, target, offset);
                const expectedRaw = target - offset;
                if (end <= expectedRaw) {
                    throw new Error(`切片越界：end=${end} ≤ target=${expectedRaw}（共 ${all.length} 条）`);
                }

                // 若中途发生删楼导致缓存长度超过本次终点，安全重置增量缓冲
                if (cachedEnd > end) {
                    parts.length = 0;
                    if (format === 'jsonl') {
                        parts.push(headerLine, '\n');
                        totalChars = headerLine.length + 1;
                    } else {
                        totalChars = 0;
                        txtHasItem = false;
                    }
                    cachedEnd = 0;
                }

                const maxAllowed = expectedRaw + 1 + swallowCap;
                if (end > maxAllowed) {
                    throw new Error(`切片自检失败：目标 ${target} 楼，实际切出 ${end} 条（上限 ${maxAllowed}，总 ${all.length} 条）— 拒绝写入`);
                }

                for (let i = cachedEnd; i < end; i += 1) {
                    const m = all[i];
                    if (format === 'txt') {
                        if (!m?.is_system) {
                            const chunk = formatTxtMessage(m);
                            if (txtHasItem) {
                                parts.push('\n\n');
                                totalChars += 2;
                            }
                            parts.push(chunk);
                            totalChars += chunk.length;
                            txtHasItem = true;
                        }
                    } else {
                        const line = JSON.stringify(m);
                        parts.push(line, '\n');
                        totalChars += line.length + 1;
                    }
                    if ((i - cachedEnd + 1) % 100 === 0) {
                        await yieldToMain();
                    }
                }
                cachedEnd = end;

                const blob = partsToBlob(format === 'txt' ? [...parts, '\n'] : parts, format);
                log(`回溯 ${target} 楼：切出 ${end}/${all.length} 条，约 ${totalChars} 字符`);

                const dirName = buildFileName(identity, format, false, target);
                const dlName = buildFileName(identity, format, true, target);

                let savedAs;
                if (handle && dirHandle) {
                    try {
                        savedAs = await writeViaFsa(handle, pathSegments, dirName, blob, {
                            dirHandle,
                            existingNames,
                            skipPermissionCheck: true,
                        });
                    } catch (e) {
                        log('回溯：FSA 写入失败，回退下载', e);
                        if (done > 0) await sleep(250);
                        savedAs = writeViaDownload(dlName, blob, format, { revokeDelayMs: 1200 });
                    }
                } else {
                    if (done > 0) await sleep(250);
                    savedAs = writeViaDownload(dlName, blob, format, { revokeDelayMs: 1200 });
                }

                done += 1;
                lastOk = target;
                written.push(String(target));
                log(`回溯备份 ${target} 楼 → ${savedAs}`);
            } catch (e) {
                console.error(`[${MODULE_NAME}] 回溯 ${target} 楼失败`, e);
                notify(`回溯到第 ${target} 楼时失败：${e?.message || e}`, 'error');
                break;
            }
        }

        const counter = getCounter(identity.key);
        counter.name = identity.cardName;
        counter.initialized = true;
        counter.backfilledFloor = lastOk;
        counter.exports = (counter.exports || 0) + done;
        if (done > 0) counter.lastExportAt = timestampSlug();
        if ((counter.lastFloor ?? 0) < lastOk) counter.lastFloor = lastOk;
        saveSettings();

        if (done > 0) {
            const preview = written.length > 8
                ? `${written.slice(0, 3).join(' / ')} … ${written.slice(-2).join(' / ')}`
                : written.join(' / ');
            notify(`回溯备份完成：${done} 个文件（${preview} 楼）`, 'success');
        }
        scheduleRefresh({ force: true });
        return { ok: true, done, lastOk };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 回溯备份失败`, e);
        notify(`回溯备份失败：${e?.message || e}`, 'error');
        return { ok: false, reason: e?.message || String(e) };
    } finally {
        busy = false;
        uiState.backfillProgress = null;
        syncBusyUI();
    }
}

/** 把历史空档标记为已备份（不生成文件） */
function markBackfilled(identity) {
    const counter = getCounter(identity.key);
    const interval = intervalValue();
    counter.backfilledFloor = Math.floor(identity.floor / interval) * interval;
    counter.name = identity.cardName;
    saveSettings();
    scheduleRefresh({ force: true });
    notify(`已把「${identity.cardName}」的历史空档标记为已备份（至 ${counter.backfilledFloor} 楼）`, 'info');
}

function isTargetReplyEmpty(messages, identity, eventArg, offset) {
    const idx = (typeof eventArg === 'number' && Number.isInteger(eventArg) && eventArg >= 0 && eventArg < messages.length && !messages[eventArg]?.is_system)
        ? eventArg
        : resolveWatchIndex(messages, identity.floor, offset);
    if (idx < 0) return true;
    return isMessageEmpty(messages[idx]);
}

async function finalizePreviousMilestoneIfNeeded(identity) {
    const s = settings();
    if (!s.enabled || !s.updateLatestOnRewrite || s.writeMode !== 'fsa' || !fsaSupported()) return;
    const peek = peekCounter(identity.key);
    if (!peek._exists || !peek.lastBackupFile || peek.lastBackupWatchIndex < 0) return;
    if (identity.floor <= peek.lastFloor) return;

    const messages = Array.isArray(ctx().chat) ? ctx().chat : [];
    const prevMsg = messages[peek.lastBackupWatchIndex];
    if (!prevMsg) return;
    if (s.skipEmptyReply && isMessageEmpty(prevMsg)) return;
    if (messageFingerprint(prevMsg) === peek.lastBackupFp) return;

    cancelPendingRewrite();
    log(`检测到推进至 #${identity.floor} 楼时，上一里程碑 #${peek.lastFloor} 楼内容有变动，立即切片定稿`);
    await tryOverwriteMilestone(identity, getCounter(identity.key), '进入下楼前定稿');
}

async function onChatActivity(trigger, eventArg = null) {
    try {
        const s = settings();
        if (!s.enabled) return;

        const identity = currentIdentity(false);
        if (!hasActiveChat(identity)) return;

        const messages = Array.isArray(ctx().chat) ? ctx().chat : [];
        const offset = Number(s.floorOffset) || 0;
        const counterPeek = peekCounter(identity.key);

        // 1. 方案 B：已推进到后续楼层时，先检查上一里程碑在离开前是否有未落盘的重生成/Swipe 定稿
        if (trigger !== 'delete' && counterPeek._exists && identity.floor > counterPeek.lastFloor) {
            await finalizePreviousMilestoneIfNeeded(identity);
        }

        // 2. 停留在刚备份过的里程碑楼层发生重生成/Swipe/编辑：安排防抖原地覆写（仅 FSA 模式）
        if (
            (trigger === 'ai' || trigger === 'swipe' || trigger === 'edit')
            && counterPeek._exists
            && identity.floor === counterPeek.lastFloor
            && counterPeek.lastBackupFile
        ) {
            const labelMap = { ai: '重生成更新', swipe: 'Swipe 切换更新', edit: '编辑内容更新' };
            scheduleMilestoneRewrite(identity, labelMap[trigger] || '更新');
        }

        // 3. 删楼事件：仅同步对齐回退基线，不触发导出
        if (trigger === 'delete') {
            cancelPendingRewrite();
            shouldExport(identity);
            if (uiState.deferredKey === identity.key) {
                uiState.deferredReason = '';
                uiState.deferredKey = '';
            }
            scheduleRefresh();
            return;
        }

        // 4. 仅 AI 计数模式过滤（保留 swipe 对 AI 楼的补备能力，以及编辑非用户消息的补备能力）
        if (s.countMode === 'ai' && trigger !== 'ai' && trigger !== 'recheck') {
            if (trigger === 'swipe') {
                const msg = (typeof eventArg === 'number' && messages[eventArg]) ? messages[eventArg] : messages[messages.length - 1];
                if (msg?.is_user) {
                    scheduleRefresh();
                    return;
                }
            } else if (trigger === 'edit') {
                const msg = (typeof eventArg === 'number' && messages[eventArg]) ? messages[eventArg] : null;
                if (!msg || msg.is_user) {
                    scheduleRefresh();
                    return;
                }
            } else {
                scheduleRefresh();
                return;
            }
        }

        // 5. 常规里程碑触发判定（含空回拦截：空消息不导出且不推进 lastFloor）
        if (shouldExport(identity)) {
            if (s.skipEmptyReply && isTargetReplyEmpty(messages, identity, eventArg, offset)) {
                uiState.deferredKey = identity.key;
                uiState.deferredReason = `#${identity.floor} 楼内容为空，已延后备份`;
                log(`空回拦截：key=${identity.key} floor=${identity.floor} 为空，跳过本次导出并保留基线`);
                scheduleRefresh();
                return;
            }
            log(`触发自动备份 key=${identity.key} floor=${identity.floor} interval=${s.interval}`);
            await runBackup();
        } else {
            if (uiState.deferredKey === identity.key && !isTargetReplyEmpty(messages, identity, eventArg, offset)) {
                uiState.deferredReason = '';
                uiState.deferredKey = '';
            }
            scheduleRefresh();
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 楼层计数处理失败`, e);
    }
}

async function onFloorAdvance(trigger, eventArg = null) {
    return onChatActivity(trigger, eventArg);
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

function panelHost() {
    return document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
}

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
}

function faIcon(cls) {
    const i = document.createElement('i');
    i.className = cls;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

function makeSwitch(id, checked, onChange) {
    const wrap = el('label', 'cab-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    if (id) input.id = id;
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange(input.checked));
    const track = el('span', 'cab-switch-track');
    wrap.append(input, track);
    return { wrap, input };
}

function makeField(titleText, hintText = '') {
    const field = el('div', 'cab-field');
    const label = el('div', 'cab-field-label');
    label.append(el('span', 'cab-field-title', titleText));
    if (hintText) label.append(el('span', 'cab-field-hint', hintText));
    field.append(label);
    return { field, label };
}

function makeSegment(id, options, currentValue, onChange) {
    const group = el('div', 'cab-segment');
    if (id) group.id = id;
    for (const [value, text] of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cab-segment-btn' + (value === currentValue ? ' is-active' : '');
        btn.dataset.value = value;
        btn.textContent = text;
        btn.addEventListener('click', () => {
            onChange(value);
        });
        group.append(btn);
    }
    return group;
}

function setSegmentValue(id, value) {
    const group = document.getElementById(id);
    if (!group) return;
    for (const btn of group.querySelectorAll('.cab-segment-btn')) {
        btn.classList.toggle('is-active', btn.dataset.value === value);
    }
}

function switchTab(tabName) {
    uiState.activeTab = tabName;
    const root = document.getElementById('chat_autobackup_content');
    if (!root) return;
    for (const btn of root.querySelectorAll('.cab-tab')) {
        btn.classList.toggle('is-active', btn.dataset.tab === tabName);
    }
    for (const panel of root.querySelectorAll('.cab-tab-panel')) {
        panel.classList.toggle('is-active', panel.dataset.tab === tabName);
    }
    if (isDrawerOpen()) {
        refreshPanel({ onlyTab: tabName, forceRender: true });
    } else {
        panelDirty = true;
    }
}

function isDrawerOpen() {
    const drawer = document.querySelector('#chat_autobackup_container .inline-drawer');
    return Boolean(drawer?.classList.contains('open'));
}

function buildPanel() {
    if (document.getElementById('chat_autobackup_container')) return;
    const host = panelHost();
    if (!host) {
        log('未找到扩展设置容器，稍后重试');
        return;
    }

    const container = el('div', 'chat-autobackup-container');
    container.id = 'chat_autobackup_container';

    const drawer = el('div', 'inline-drawer');

    const header = el('div', 'inline-drawer-toggle inline-drawer-header cab-drawer-header');
    const headerLeft = el('div', 'cab-header-left');
    headerLeft.append(
        faIcon('fa-solid fa-box-archive cab-header-icon'),
        el('span', 'cab-header-title', '聊天记录自动备份'),
        el('span', 'cab-ver-pill', `v${EXT_VERSION}`),
    );
    const headerRight = el('div', 'cab-header-right');
    const statusDot = el('span', 'cab-header-dot');
    statusDot.id = 'cab_header_dot';
    statusDot.title = '自动备份运行状态';
    const icon = el('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down');
    headerRight.append(statusDot, icon);
    header.append(headerLeft, headerRight);

    const content = el('div', 'inline-drawer-content');
    content.id = 'chat_autobackup_content';

    drawer.append(header, content);
    container.append(drawer);
    host.append(container);

    header.addEventListener('click', () => {
        const opened = drawer.classList.toggle('open');
        if (opened && panelDirty) {
            panelDirty = false;
            refreshPanel({ forceRender: true });
        }
    });

    renderControls(content);
    refreshPanel({ forceRender: true });
}

function buildSettingsRuleCard(s) {
    const card = el('div', 'cab-card');
    card.append(el('div', 'cab-card-title', '备份规则'));

    // 导出间隔 + 快捷档位
    const intervalWrap = el('div', 'cab-field');
    const intervalRow = el('div', 'cab-field-row');
    const intervalLabel = el('div', 'cab-field-label');
    intervalLabel.append(
        el('span', 'cab-field-title', '导出间隔'),
        el('span', 'cab-field-hint', '每新增指定楼层自动备份，各角色卡独立计数'),
    );
    const inputGroup = el('div', 'cab-input-group');
    const intervalInput = document.createElement('input');
    intervalInput.id = 'cab_interval_input';
    intervalInput.type = 'number';
    intervalInput.min = '1';
    intervalInput.step = '1';
    intervalInput.className = 'cab-number';
    intervalInput.value = String(s.interval);
    const applyInterval = (val) => {
        const value = Math.max(1, parseInt(val, 10) || 1);
        settings().interval = value;
        intervalInput.value = String(value);
        saveSettings();
        refreshPanel();
    };
    intervalInput.addEventListener('change', () => applyInterval(intervalInput.value));
    inputGroup.append(intervalInput, el('span', 'cab-input-suffix', '楼'));
    intervalRow.append(intervalLabel, inputGroup);

    const presets = el('div', 'cab-presets');
    presets.id = 'cab_interval_presets';
    for (const preset of [10, 20, 50, 100]) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'cab-chip';
        chip.dataset.preset = String(preset);
        chip.textContent = `每 ${preset} 楼`;
        chip.addEventListener('click', () => applyInterval(preset));
        presets.append(chip);
    }
    intervalWrap.append(intervalRow, presets);
    card.append(intervalWrap, el('div', 'cab-divider'));

    // 导出格式
    const fmt = makeField('导出格式', 'JSONL 可完整回导酒馆；TXT 适合直接阅读');
    fmt.field.append(makeSegment('cab_format_seg', [
        ['jsonl', 'JSONL（可回导）'],
        ['txt', 'TXT（纯文本）'],
    ], s.format, (val) => {
        settings().format = val;
        saveSettings();
        refreshPanel();
    }));
    card.append(fmt.field, el('div', 'cab-divider'));

    // 导出数据源
    const srcField = makeField('数据源（JSONL）', '本地直出直接读内存零拷贝写盘，大聊天极快（TXT 仍走服务端）');
    srcField.field.append(makeSegment('cab_source_seg', [
        ['local', '本地直出（极速）'],
        ['server', '服务端导出'],
    ], s.exportSource, (val) => {
        settings().exportSource = val;
        saveSettings();
        refreshPanel({ forceRender: true });
    }));
    card.append(srcField.field, el('div', 'cab-divider'));

    // 计数方式
    const cnt = makeField('计数方式', '全部楼层：用户与 AI 各算一楼；仅 AI：一轮算一楼');
    cnt.field.append(makeSegment('cab_count_seg', [
        ['all', '全部楼层'],
        ['ai', '仅 AI 楼层'],
    ], s.countMode, (val) => {
        settings().countMode = val;
        saveSettings();
        refreshPanel({ forceRender: true });
    }));
    card.append(cnt.field, el('div', 'cab-divider'));

    // 空回拦截
    const emptyRow = el('div', 'cab-field-row');
    const emptyLabel = el('div', 'cab-field-label');
    emptyLabel.append(
        el('span', 'cab-field-title', '空回拦截'),
        el('span', 'cab-field-hint', '最新楼为空白或空标签时延后备份，等重新生成有效内容后再导'),
    );
    const emptySw = makeSwitch('cab_skip_empty_switch', s.skipEmptyReply, (checked) => {
        settings().skipEmptyReply = checked;
        saveSettings();
    });
    emptyRow.append(emptyLabel, emptySw.wrap);
    card.append(emptyRow, el('div', 'cab-divider'));

    // 重生成/Swipe 自动更新
    const rewriteRow = el('div', 'cab-field-row');
    const rewriteLabel = el('div', 'cab-field-label');
    rewriteLabel.append(
        el('span', 'cab-field-title', '重生成 / Swipe 自动更新'),
        el('span', 'cab-field-hint', '授权目录模式下停留在刚备份楼层重写时，防抖原地覆写（进入下楼兜底定稿）'),
    );
    const rewriteSw = makeSwitch('cab_rewrite_switch', s.updateLatestOnRewrite, (checked) => {
        settings().updateLatestOnRewrite = checked;
        saveSettings();
    });
    rewriteRow.append(rewriteLabel, rewriteSw.wrap);
    card.append(rewriteRow, el('div', 'cab-divider'));

    // 导出后提示
    const toastRow = el('div', 'cab-field-row');
    const toastLabel = el('div', 'cab-field-label');
    toastLabel.append(
        el('span', 'cab-field-title', '导出完成提醒'),
        el('span', 'cab-field-hint', '自动或手动导出后在右上角弹出提示'),
    );
    const toastSw = makeSwitch('cab_toast_switch', s.toast, (checked) => {
        settings().toast = checked;
        saveSettings();
    });
    toastRow.append(toastLabel, toastSw.wrap);
    card.append(toastRow);

    return card;
}

function buildSettingsStorageCard(s) {
    const card = el('div', 'cab-card');
    card.append(el('div', 'cab-card-title', '存储与命名'));

    // 保存方式
    const wm = makeField('保存方式', '授权目录只需选一次，之后自动按角色卡建文件夹');
    wm.field.append(makeSegment('cab_write_seg', [
        ['fsa', '授权目录（推荐）'],
        ['download', '浏览器下载'],
    ], s.writeMode, (val) => {
        settings().writeMode = val;
        saveSettings();
        refreshPanel();
    }));
    card.append(wm.field);

    // FSA 专属选项组
    const fsaGroup = el('div', 'cab-field');
    fsaGroup.id = 'cab_fsa_group';

    const dirBox = el('div', 'cab-dir-box');
    const dirStatus = el('div', 'cab-dir-status');
    dirStatus.id = 'cab_dir_status';
    const dirIcon = faIcon('fa-solid fa-folder');
    dirIcon.id = 'cab_dir_icon';
    const dirLabel = el('span', 'cab-dir-name');
    dirLabel.id = 'cab_root_label';
    dirStatus.append(dirIcon, dirLabel);

    const dirActions = el('div', 'cab-dir-actions');
    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'cab-btn cab-btn-sm cab-btn-primary';
    pickBtn.append(faIcon('fa-solid fa-folder-open'), el('span', '', '选择备份根目录'));
    pickBtn.addEventListener('click', async () => {
        try {
            const handle = await pickBackupRoot();
            if (handle) notify('备份根目录已授权', 'success');
        } catch (e) {
            log('选择目录取消或失败', e);
        }
    });
    const clearBtn = document.createElement('button');
    clearBtn.id = 'cab_dir_clear_btn';
    clearBtn.type = 'button';
    clearBtn.className = 'cab-btn cab-btn-sm cab-btn-ghost';
    clearBtn.append(faIcon('fa-solid fa-link-slash'), el('span', '', '清除授权'));
    clearBtn.addEventListener('click', async () => {
        await idbDelete(IDB_KEY_ROOT);
        cachedRootHandle = null;
        settings().rootName = '';
        saveSettings();
        refreshPanel({ forceRender: true });
        notify('已清除目录授权，将回退为浏览器下载', 'info');
    });
    dirActions.append(pickBtn, clearBtn);
    dirBox.append(dirStatus, dirActions);
    fsaGroup.append(dirBox);

    // 目录层级
    const depth = makeField('目录层级', '推荐按「角色卡 / 聊天记录」归档，同卡多档互不混淆');
    const depthSelect = document.createElement('select');
    depthSelect.id = 'cab_depth_select';
    depthSelect.className = 'cab-select';
    for (const [value, text] of [
        ['card_chat', '角色卡 / 聊天记录（默认）'],
        ['card', '仅按角色卡分文件夹'],
        ['chat', '仅按聊天记录分文件夹'],
        ['none', '全部平铺到根目录'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        depthSelect.append(option);
    }
    depthSelect.value = s.folderDepth;
    depthSelect.addEventListener('change', () => {
        settings().folderDepth = depthSelect.value;
        saveSettings();
        refreshPanel();
    });
    depth.field.append(depthSelect);
    fsaGroup.append(depth.field);

    // 聊天文件夹命名
    const cf = makeField('聊天文件夹命名', '创建日期取首楼时间，例：星野光.2026.9.1');
    cf.field.id = 'cab_chat_folder_field';
    const chatFolderSelect = document.createElement('select');
    chatFolderSelect.id = 'cab_chat_folder_select';
    chatFolderSelect.className = 'cab-select';
    for (const [value, text] of [
        ['created', '角色卡名.创建日期（推荐）'],
        ['chatid', '原始聊天文件名'],
        ['datetime', '每次导出时间戳'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        chatFolderSelect.append(option);
    }
    chatFolderSelect.value = s.chatFolderName;
    chatFolderSelect.addEventListener('change', () => {
        settings().chatFolderName = chatFolderSelect.value;
        saveSettings();
        refreshPanel();
    });
    cf.field.append(chatFolderSelect);
    fsaGroup.append(cf.field);
    card.append(fsaGroup);

    // 下载模式专属选项
    const dlGroup = el('div', 'cab-field-row');
    dlGroup.id = 'cab_dl_group';
    const dlLabel = el('div', 'cab-field-label');
    dlLabel.append(
        el('span', 'cab-field-title', '文件名包含聊天名'),
        el('span', 'cab-field-hint', '下载模式用：角色卡——聊天名——USER——楼层'),
    );
    const dlSw = makeSwitch('cab_dl_include_switch', s.downloadIncludeChat, (checked) => {
        settings().downloadIncludeChat = checked;
        saveSettings();
        refreshPanel();
    });
    dlGroup.append(dlLabel, dlSw.wrap);
    card.append(dlGroup, el('div', 'cab-divider'));

    // 同名文件处理
    const cflict = makeField('同名文件处理', '追加序号可保留每次手动备份的历史副本');
    cflict.field.append(makeSegment('cab_conflict_seg', [
        ['suffix', '追加序号 (2)(3)'],
        ['overwrite', '覆盖原文件'],
    ], s.onConflict, (val) => {
        settings().onConflict = val;
        saveSettings();
        refreshPanel();
    }));
    card.append(cflict.field);

    // 实时路径预览
    const preview = el('div', 'cab-preview-box');
    preview.append(el('span', 'cab-preview-label', '实时导出路径预览'));
    const previewCode = el('span', 'cab-preview-code');
    previewCode.id = 'cab_path_preview';
    preview.append(previewCode);
    card.append(preview);

    return card;
}

function buildSettingsAdvancedCard(s) {
    const details = el('details', 'cab-details');
    details.id = 'cab_adv_details';

    const summary = document.createElement('summary');
    const sumLeft = el('div', 'cab-details-summary-left');
    const advBadge = el('span', 'cab-tag cab-tag-warning cab-is-hidden', '已自定义');
    advBadge.id = 'cab_adv_badge';
    sumLeft.append(faIcon('fa-solid fa-wrench'), el('span', '', '高级与楼号校准'), advBadge);
    summary.append(sumLeft, faIcon('fa-solid fa-chevron-down cab-details-chevron'));

    const body = el('div', 'cab-details-body');

    // 楼号校准
    const offRow = el('div', 'cab-field-row');
    const offLabel = el('div', 'cab-field-label');
    offLabel.append(
        el('span', 'cab-field-title', '楼号校准偏移'),
        el('span', 'cab-field-hint', '默认 0 与界面 #N（0 起）一致；界面比面板小 N 填 -N，按 1 起计填 +1'),
    );
    const offInput = document.createElement('input');
    offInput.id = 'cab_offset_input';
    offInput.type = 'number';
    offInput.className = 'cab-number';
    offInput.step = '1';
    offInput.value = String(Number(s.floorOffset) || 0);
    offInput.addEventListener('change', () => {
        const val = Math.max(-999, Math.min(999, Number(offInput.value) || 0));
        settings().floorOffset = val;
        offInput.value = String(val);
        saveSettings();
        refreshPanel();
    });
    offRow.append(offLabel, offInput);

    // 切片尾随隐藏楼
    const swRow = el('div', 'cab-field-row');
    const swLabel = el('div', 'cab-field-label');
    swLabel.append(
        el('span', 'cab-field-title', '切片带隐藏楼上限'),
        el('span', 'cab-field-hint', '回溯切片时额外带入目标楼后连续隐藏楼的条数；推荐保持 0'),
    );
    const swInput = document.createElement('input');
    swInput.id = 'cab_swallow_input';
    swInput.type = 'number';
    swInput.className = 'cab-number';
    swInput.min = '0';
    swInput.max = '50';
    swInput.step = '1';
    swInput.value = String(Number(s.swallowHidden) || 0);
    swInput.addEventListener('change', () => {
        const val = Math.max(0, Math.min(50, Number(swInput.value) || 0));
        settings().swallowHidden = val;
        swInput.value = String(val);
        saveSettings();
        refreshPanel();
    });
    swRow.append(swLabel, swInput);

    body.append(offRow, el('div', 'cab-divider'), swRow);
    details.append(summary, body);
    return details;
}

function buildOverviewTab() {
    const panel = el('div', 'cab-tab-panel is-active');
    panel.dataset.tab = 'overview';

    // 当前聊天状态卡容器（动态填充，支持无聊天空状态）
    const statusBox = el('div');
    statusBox.id = 'cab_status';
    panel.append(statusBox);

    // 历史空档回溯提醒卡（仅当有待回溯段落时展示）
    const callout = el('div', 'cab-callout cab-is-hidden');
    callout.id = 'cab_backfill_callout';

    const calloutHead = el('div', 'cab-callout-head');
    const calloutTitle = el('span');
    calloutTitle.id = 'cab_backfill_title';
    calloutHead.append(faIcon('fa-solid fa-clock-rotate-left'), calloutTitle);

    const calloutDesc = el('div', 'cab-callout-desc');
    calloutDesc.id = 'cab_backfill_desc';

    const calloutActions = el('div', 'cab-callout-actions');
    const backfillBtn = document.createElement('button');
    backfillBtn.id = 'cab_backfill_btn';
    backfillBtn.type = 'button';
    backfillBtn.className = 'cab-btn cab-btn-sm cab-btn-warning';
    backfillBtn.addEventListener('click', () => runBackfill());

    const markBtn = document.createElement('button');
    markBtn.id = 'cab_mark_btn';
    markBtn.type = 'button';
    markBtn.className = 'cab-btn cab-btn-sm cab-btn-ghost';
    markBtn.title = '不生成文件，仅把过往历史标记为已处理';
    markBtn.append(faIcon('fa-solid fa-check-double'), el('span', '', '忽略空档'));
    markBtn.addEventListener('click', () => {
        try {
            markBackfilled(currentIdentity());
        } catch (e) {
            console.error(`[${MODULE_NAME}] 标记历史空档失败`, e);
        }
    });
    calloutActions.append(backfillBtn, markBtn);
    callout.append(calloutHead, calloutDesc, calloutActions);
    panel.append(callout);

    // 主操作按钮栏
    const actionBar = el('div', 'cab-action-bar');
    actionBar.id = 'cab_action_bar';

    const nowBtn = document.createElement('button');
    nowBtn.id = 'cab_now_btn';
    nowBtn.type = 'button';
    nowBtn.className = 'cab-btn cab-btn-primary';
    nowBtn.addEventListener('click', () => runBackup({ manual: true }));

    const resetBtn = document.createElement('button');
    resetBtn.id = 'cab_reset_btn';
    resetBtn.type = 'button';
    resetBtn.className = 'cab-btn';
    resetBtn.title = '将本卡上次导出基线重置为当前楼层，不删除已导出的文件';
    resetBtn.append(faIcon('fa-solid fa-rotate-left'), el('span', '', '重置计数'));
    resetBtn.addEventListener('click', () => {
        try {
            const identity = currentIdentity(false);
            if (!hasActiveChat(identity)) return;
            cancelPendingRewrite();
            if (uiState.deferredKey === identity.key) {
                uiState.deferredReason = '';
                uiState.deferredKey = '';
            }
            const s2 = settings();
            s2.counters[identity.key] = {
                name: identity.cardName,
                lastFloor: identity.floor,
                backfilledFloor: s2.counters[identity.key]?.backfilledFloor ?? 0,
                exports: s2.counters[identity.key]?.exports ?? 0,
                lastExportAt: s2.counters[identity.key]?.lastExportAt ?? '',
                initialized: true,
                lastBackupFile: '',
                lastBackupFp: '',
                lastBackupWatchIndex: -1,
                lastBackupFormat: '',
                lastBackupSegments: [],
            };
            saveSettings();
            refreshPanel({ forceRender: true });
            notify(`已把「${identity.cardName}」的计数基线重置为当前 #${identity.floor} 楼`, 'success');
        } catch (e) {
            console.error(`[${MODULE_NAME}] 重置计数失败`, e);
        }
    });

    actionBar.append(nowBtn, resetBtn);
    panel.append(actionBar);

    // 折叠技术详情（文件名预览、隐藏楼统计、计数键）
    const techDetails = el('details', 'cab-details');
    techDetails.id = 'cab_tech_details';
    const techSum = document.createElement('summary');
    const techLeft = el('div', 'cab-details-summary-left');
    techLeft.append(faIcon('fa-solid fa-circle-info'), el('span', '', '技术详情与文件名预览'));
    techSum.append(techLeft, faIcon('fa-solid fa-chevron-down cab-details-chevron'));
    const techBody = el('div', 'cab-details-body');
    const kvList = el('div', 'cab-kv-list');
    kvList.id = 'cab_tech_kv';
    techBody.append(kvList);
    techDetails.append(techSum, techBody);
    panel.append(techDetails);

    return panel;
}

function buildRecordsTab() {
    const panel = el('div', 'cab-tab-panel');
    panel.dataset.tab = 'records';

    // 搜索框
    const searchWrap = el('div', 'cab-search-wrap');
    searchWrap.append(faIcon('fa-solid fa-magnifying-glass cab-search-icon'));
    const searchInput = document.createElement('input');
    searchInput.id = 'cab_records_search';
    searchInput.type = 'text';
    searchInput.className = 'cab-search-input';
    searchInput.placeholder = '搜索角色卡名或会话…';
    const clearBtn = document.createElement('button');
    clearBtn.id = 'cab_records_search_clear';
    clearBtn.type = 'button';
    clearBtn.className = 'cab-search-clear cab-is-hidden';
    clearBtn.title = '清空搜索';
    clearBtn.append(faIcon('fa-solid fa-xmark'));
    searchInput.addEventListener('input', () => {
        uiState.searchQuery = searchInput.value.trim();
        clearBtn.classList.toggle('cab-is-hidden', !uiState.searchQuery);
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;
            try {
                renderRecords(settings(), currentIdentity(false));
            } catch (e) {
                log('搜索过滤失败', e);
            }
        }, 150);
    });
    clearBtn.addEventListener('click', () => {
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
        }
        searchInput.value = '';
        uiState.searchQuery = '';
        clearBtn.classList.add('cab-is-hidden');
        try {
            renderRecords(settings(), currentIdentity(false));
        } catch (e) {
            log('清空搜索刷新失败', e);
        }
        searchInput.focus();
    });
    searchWrap.append(searchInput, clearBtn);

    // 汇总与清理工具条
    const bar = el('div', 'cab-records-bar');
    const summary = el('span', 'cab-records-summary');
    summary.id = 'cab_records_summary';
    const pruneBtn = document.createElement('button');
    pruneBtn.id = 'cab_prune_btn';
    pruneBtn.type = 'button';
    pruneBtn.className = 'cab-btn cab-btn-sm cab-btn-ghost';
    pruneBtn.title = '清除从未导出过的空计数记录（不会删硬盘文件）';
    pruneBtn.addEventListener('click', () => {
        const s2 = settings();
        const before = Object.keys(s2.counters).length;
        for (const [key, counter] of Object.entries(s2.counters)) {
            if (!counter || (counter.exports === 0 && !counter.lastExportAt)) delete s2.counters[key];
        }
        saveSettings();
        refreshPanel({ forceRender: true });
        notify(`已清理 ${before - Object.keys(s2.counters).length} 条从未导出过的无效记录`, 'info');
    });
    bar.append(summary, pruneBtn);

    const listWrap = el('div', 'cab-record-list');
    listWrap.id = 'cab_counters';
    listWrap.addEventListener('click', (ev) => {
        const btn = ev.target?.closest?.('.cab-record-del');
        if (!btn) return;
        const key = btn.dataset.key;
        if (!key) return;
        const s2 = settings();
        const cardName = s2.counters[key]?.name || '(未命名角色卡)';
        delete s2.counters[key];
        saveSettings();
        refreshPanel({ forceRender: true });
        notify(`已移除「${cardName}」的计数记录`, 'info');
    });

    panel.append(searchWrap, bar, listWrap);
    return panel;
}

function renderControls(root) {
    const s = settings();

    // 顶部快捷状态条（总开关 + 存储位置快捷入口）
    const topbar = el('div', 'cab-topbar');
    const masterGroup = el('div', 'cab-master-group');
    const masterSw = makeSwitch('cab_master_toggle', s.enabled, (checked) => {
        settings().enabled = checked;
        saveSettings();
        refreshPanel();
    });
    const masterMeta = el('div', 'cab-master-meta');
    const masterTitle = el('span', 'cab-master-title', '自动备份');
    const masterSub = el('span', 'cab-master-sub');
    masterSub.id = 'cab_master_sub';
    masterMeta.append(masterTitle, masterSub);
    masterGroup.append(masterSw.wrap, masterMeta);

    const storagePill = document.createElement('button');
    storagePill.id = 'cab_storage_pill';
    storagePill.type = 'button';
    storagePill.className = 'cab-storage-pill';
    storagePill.addEventListener('click', async () => {
        const cur = settings();
        if (cur.writeMode === 'fsa' && fsaSupported()) {
            try {
                const handle = await pickBackupRoot();
                if (handle) notify('备份根目录已授权', 'success');
            } catch (e) {
                log('选择目录取消或失败', e);
            }
        } else {
            switchTab('settings');
        }
    });
    topbar.append(masterGroup, storagePill);
    root.append(topbar);

    // 三标签导航
    const tabs = el('div', 'cab-tabs');
    const tabDefs = [
        ['overview', 'fa-solid fa-gauge-high', '当前概览'],
        ['settings', 'fa-solid fa-sliders', '参数设置'],
        ['records', 'fa-solid fa-layer-group', '全部记录'],
    ];
    for (const [id, iconCls, label] of tabDefs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cab-tab' + (id === uiState.activeTab ? ' is-active' : '');
        btn.dataset.tab = id;
        btn.append(faIcon(iconCls), el('span', '', label));
        if (id === 'records') {
            const badge = el('span', 'cab-tab-badge', '0');
            badge.id = 'cab_records_badge';
            btn.append(badge);
        }
        btn.addEventListener('click', () => switchTab(id));
        tabs.append(btn);
    }
    root.append(tabs);

    // 三个标签页面板
    const settingsPanel = el('div', 'cab-tab-panel');
    settingsPanel.dataset.tab = 'settings';
    settingsPanel.append(
        buildSettingsRuleCard(s),
        buildSettingsStorageCard(s),
        buildSettingsAdvancedCard(s),
    );

    root.append(buildOverviewTab(), settingsPanel, buildRecordsTab());
}

function syncHeaderDot(s) {
    const interval = intervalValue(s);
    const fmtUpper = (s.format === 'txt' ? 'TXT' : 'JSONL');
    const dot = document.getElementById('cab_header_dot');
    if (dot) {
        dot.classList.toggle('is-paused', !s.enabled);
        dot.title = s.enabled ? `自动备份运行中（每 ${interval} 楼 · ${fmtUpper}）` : '自动备份已暂停';
    }
}

function syncTopbarAndSettings(s, identity, { syncSettingsTab = true } = {}) {
    const interval = intervalValue(s);
    const fmtUpper = (s.format === 'txt' ? 'TXT' : 'JSONL');

    syncHeaderDot(s);

    // 顶部总开关与副标题
    const masterToggle = document.getElementById('cab_master_toggle');
    if (masterToggle) masterToggle.checked = Boolean(s.enabled);
    const masterSub = document.getElementById('cab_master_sub');
    if (masterSub) {
        masterSub.textContent = s.enabled ? `每 ${interval} 楼 · ${fmtUpper}` : '已暂停自动触发';
    }

    // 顶部存储状态胶囊
    const pill = document.getElementById('cab_storage_pill');
    if (pill) {
        pill.textContent = '';
        pill.className = 'cab-storage-pill';
        if (s.writeMode === 'fsa') {
            if (!fsaSupported()) {
                pill.classList.add('is-warn');
                pill.append(faIcon('fa-solid fa-triangle-exclamation'), el('span', '', '不支持目录 · 回退下载'));
                pill.title = '当前浏览器不支持目录授权，点击查看保存设置';
            } else if (s.rootName) {
                pill.classList.add('is-ok');
                pill.append(faIcon('fa-solid fa-folder-open'), el('span', '', s.rootName));
                pill.title = `已授权根目录：${s.rootName}（点击可更换目录）`;
            } else {
                pill.classList.add('is-warn');
                pill.append(faIcon('fa-solid fa-folder-plus'), el('span', '', '未选目录 · 点此授权'));
                pill.title = '尚未授权备份根目录，当前会回退为浏览器下载；点击立即授权';
            }
        } else {
            pill.classList.add('is-dl');
            pill.append(faIcon('fa-solid fa-download'), el('span', '', '浏览器下载'));
            pill.title = '当前为浏览器下载模式（点击进入设置）';
        }
    }

    if (!syncSettingsTab) return;

    // 同步设置页控件状态
    const intervalInput = document.getElementById('cab_interval_input');
    if (intervalInput && document.activeElement !== intervalInput) intervalInput.value = String(interval);
    const presets = document.getElementById('cab_interval_presets');
    if (presets) {
        for (const chip of presets.querySelectorAll('.cab-chip')) {
            chip.classList.toggle('is-active', Number(chip.dataset.preset) === interval);
        }
    }
    setSegmentValue('cab_format_seg', s.format);
    setSegmentValue('cab_source_seg', s.exportSource);
    setSegmentValue('cab_count_seg', s.countMode);
    setSegmentValue('cab_write_seg', s.writeMode);
    setSegmentValue('cab_conflict_seg', s.onConflict);

    const skipEmptySw = document.getElementById('cab_skip_empty_switch');
    if (skipEmptySw) skipEmptySw.checked = Boolean(s.skipEmptyReply);
    const rewriteSw = document.getElementById('cab_rewrite_switch');
    if (rewriteSw) rewriteSw.checked = Boolean(s.updateLatestOnRewrite);
    const toastSw = document.getElementById('cab_toast_switch');
    if (toastSw) toastSw.checked = Boolean(s.toast);
    const dlSw = document.getElementById('cab_dl_include_switch');
    if (dlSw) dlSw.checked = Boolean(s.downloadIncludeChat);

    // 条件展示 FSA / 下载选项
    const isFsa = s.writeMode === 'fsa';
    document.getElementById('cab_fsa_group')?.classList.toggle('cab-is-hidden', !isFsa);
    document.getElementById('cab_dl_group')?.classList.toggle('cab-is-hidden', isFsa);

    const depthSelect = document.getElementById('cab_depth_select');
    if (depthSelect) depthSelect.value = s.folderDepth;
    const cfSelect = document.getElementById('cab_chat_folder_select');
    if (cfSelect) cfSelect.value = s.chatFolderName;
    const cfField = document.getElementById('cab_chat_folder_field');
    if (cfField) {
        const needsChatFolder = s.folderDepth === 'card_chat' || s.folderDepth === 'chat';
        cfField.classList.toggle('cab-is-hidden', !needsChatFolder);
    }

    // 目录授权状态条
    const dirStatus = document.getElementById('cab_dir_status');
    const dirIcon = document.getElementById('cab_dir_icon');
    const rootLabel = document.getElementById('cab_root_label');
    const clearBtn = document.getElementById('cab_dir_clear_btn');
    if (dirStatus && rootLabel) {
        dirStatus.classList.remove('is-ok', 'is-warn');
        if (!fsaSupported()) {
            dirStatus.classList.add('is-warn');
            if (dirIcon) dirIcon.className = 'fa-solid fa-triangle-exclamation';
            rootLabel.textContent = '当前浏览器不支持目录写入（将回退下载）';
        } else if (s.rootName) {
            dirStatus.classList.add('is-ok');
            if (dirIcon) dirIcon.className = 'fa-solid fa-circle-check';
            rootLabel.textContent = `已授权：${s.rootName}`;
        } else {
            dirStatus.classList.add('is-warn');
            if (dirIcon) dirIcon.className = 'fa-solid fa-circle-exclamation';
            rootLabel.textContent = '尚未授权根目录（将自动回退浏览器下载）';
        }
        if (clearBtn) clearBtn.classList.toggle('cab-is-hidden', !s.rootName);
    }

    // 高级校准自定义徽章与数值同步
    const offVal = Number(s.floorOffset) || 0;
    const swVal = Number(s.swallowHidden) || 0;
    const offInput = document.getElementById('cab_offset_input');
    if (offInput && document.activeElement !== offInput) offInput.value = String(offVal);
    const swInput = document.getElementById('cab_swallow_input');
    if (swInput && document.activeElement !== swInput) swInput.value = String(swVal);
    document.getElementById('cab_adv_badge')?.classList.toggle('cab-is-hidden', offVal === 0 && swVal === 0);

    // 实时导出路径预览
    const preview = document.getElementById('cab_path_preview');
    if (preview) {
        const sample = hasActiveChat(identity) ? identity : {
            cardName: '角色卡示例',
            userName: identity?.userName || 'USER',
            chatId: '角色卡示例 - 2026-11-23@10h00m00s000ms',
            floor: 50,
        };
        const format = s.format === 'txt' ? 'txt' : 'jsonl';
        if (isFsa) {
            const segs = backupPathSegments(sample);
            const file = buildFileName(sample, format, false, sample.floor);
            preview.textContent = [s.rootName || '备份根目录', ...segs, file].join('\\');
        } else {
            preview.textContent = `浏览器下载目录\\${buildFileName(sample, format, true, sample.floor)}`;
        }
    }
}

function renderOverview(s, identity, pending) {
    const statusBox = document.getElementById('cab_status');
    const callout = document.getElementById('cab_backfill_callout');
    const actionBar = document.getElementById('cab_action_bar');
    const techDetails = document.getElementById('cab_tech_details');
    const techKv = document.getElementById('cab_tech_kv');
    if (!statusBox) return;

    statusBox.textContent = '';

    if (!hasActiveChat(identity)) {
        const empty = el('div', 'cab-empty-card');
        empty.append(
            faIcon('fa-solid fa-comments'),
            el('div', 'cab-empty-title', '当前未打开聊天'),
            el('div', 'cab-empty-desc', '请先打开一个角色卡或群聊，此处会实时展示楼层进度并提供快捷备份操作。'),
        );
        statusBox.append(empty);
        callout?.classList.add('cab-is-hidden');
        actionBar?.classList.add('cab-is-hidden');
        techDetails?.classList.add('cab-is-hidden');
        return;
    }

    actionBar?.classList.remove('cab-is-hidden');
    techDetails?.classList.remove('cab-is-hidden');

    const counter = peekCounter(identity.key);
    const interval = intervalValue(s);
    const base = baselineFloor(identity, s);
    const remain = remainingFloors(identity);
    const progressed = Math.max(0, Math.min(interval, identity.floor - base));
    const pct = Math.min(100, Math.round((progressed / interval) * 100));
    const nextTarget = base + interval;
    const session = formatChatSession(identity.chatId, identity.cardName);
    const lastTime = formatReadableTime(counter.lastExportAt);
    const format = s.format === 'txt' ? 'txt' : 'jsonl';
    const pathSegments = backupPathSegments(identity);
    const targetFolder = s.writeMode === 'fsa'
        ? [s.rootName || '备份根目录', ...pathSegments].join('\\')
        : '浏览器下载目录';
    const previewFile = buildFileName(identity, format, s.writeMode !== 'fsa', identity.floor);

    const card = el('div', 'cab-card');

    // 身份区：角色卡 + USER + 会话时间
    const heroHead = el('div', 'cab-hero-head');
    const avatarBadge = el('div', 'cab-avatar-badge');
    avatarBadge.append(faIcon(identity.isGroup ? 'fa-solid fa-users' : 'fa-solid fa-address-card'));
    const idCol = el('div', 'cab-hero-identity');
    const nameEl = el('div', 'cab-hero-name', identity.cardName);
    nameEl.title = identity.cardName;
    const subEl = el('div', 'cab-hero-sub');
    subEl.append(el('span', '', `USER：${identity.userName}`));
    if (session.label) {
        subEl.append(el('span', '', '·'));
        const sessSpan = el('span', '', session.label);
        sessSpan.title = session.raw;
        subEl.append(sessSpan);
    }
    if (session.imported) subEl.append(el('span', 'cab-tag cab-tag-accent', '导入'));
    if (identity.isGroup) subEl.append(el('span', 'cab-tag', '群聊'));
    idCol.append(nameEl, subEl);
    heroHead.append(avatarBadge, idCol);
    card.append(heroHead);

    // 楼层与下次自动备份进度条
    const progBlock = el('div', 'cab-progress-block');
    const floorRow = el('div', 'cab-floor-row');
    const floorMain = el('div', 'cab-floor-main');
    floorMain.append(
        el('span', 'cab-floor-num', `#${identity.floor}`),
        el('span', 'cab-floor-unit', `当前楼层 · 共 ${identity.total ?? 0} 条${identity.hidden ? `（${identity.hidden} 隐藏）` : ''}`),
    );
    const isDeferred = uiState.deferredKey === identity.key && Boolean(uiState.deferredReason);
    const isRewritePending = uiState.rewritePending && rewritePendingKey === identity.key;
    let nextText = '自动备份已暂停';
    if (s.enabled) {
        if (isDeferred) nextText = '空回已延后（等待重生成）';
        else if (isRewritePending) nextText = '检测到重写 · 即将更新';
        else if (remain === 0) nextText = '即将自动导出';
        else nextText = `距下次还差 ${remain} 楼`;
    }
    const nextPill = el(
        'span',
        'cab-next-pill' + (s.enabled ? '' : ' is-paused'),
        nextText,
    );
    if (isDeferred) nextPill.title = uiState.deferredReason;
    floorRow.append(floorMain, nextPill);

    const track = el('div', 'cab-progress-track');
    const fill = el('div', 'cab-progress-fill');
    fill.style.width = `${pct}%`;
    track.append(fill);

    const foot = el('div', 'cab-progress-foot');
    foot.append(
        el('span', '', `上次基线 #${base}`),
        el('span', '', `目标 #${nextTarget}（${progressed}/${interval}）`),
    );
    progBlock.append(floorRow, track, foot);
    card.append(progBlock);

    // 三栏核心指标卡
    const metrics = el('div', 'cab-metrics-grid');
    const makeTile = (label, value, sub, tone = '', titleTip = '') => {
        const tile = el('div', 'cab-metric-tile');
        if (titleTip) tile.title = titleTip;
        tile.append(
            el('span', 'cab-metric-label', label),
            el('span', 'cab-metric-value' + (tone ? ` ${tone}` : ''), value),
            el('span', 'cab-metric-sub', sub),
        );
        return tile;
    };
    metrics.append(
        makeTile('本卡累计导出', `${counter.exports ?? 0} 次`, `上次 #${counter.lastFloor ?? 0} 楼`),
        makeTile(
            '最近一次备份',
            lastTime.text,
            lastTime.full ? lastTime.full.slice(0, 10) : '等待首次导出',
            '',
            lastTime.full ? `精确时间：${lastTime.full}` : '',
        ),
        makeTile(
            '历史回溯',
            pending.length ? `待补 ${pending.length} 段` : '已齐备',
            `已回溯至 #${counter.backfilledFloor ?? 0} 楼`,
            pending.length ? 'is-warn' : 'is-ok',
        ),
    );
    card.append(metrics);

    // 保存路径条
    const pathBar = el('div', 'cab-path-bar');
    pathBar.title = `保存位置：${targetFolder}\n文件名：${previewFile}`;
    pathBar.append(
        faIcon(s.writeMode === 'fsa' ? 'fa-solid fa-folder-tree' : 'fa-solid fa-download'),
        el('span', 'cab-path-text', targetFolder),
    );
    card.append(pathBar);
    statusBox.append(card);

    // 历史空档提醒卡片
    if (callout) {
        const hasPending = pending.length > 0;
        callout.classList.toggle('cab-is-hidden', !hasPending);
        if (hasPending) {
            const titleEl = document.getElementById('cab_backfill_title');
            const descEl = document.getElementById('cab_backfill_desc');
            if (titleEl) titleEl.textContent = `发现 ${pending.length} 段历史楼层尚未备份`;
            if (descEl) descEl.textContent = `覆盖楼层：${formatSegments(pending, 8)} · 已回溯至 #${counter.backfilledFloor ?? 0} 楼`;
        }
    }

    // 折叠技术详情
    if (techKv) {
        techKv.textContent = '';
        const kvs = [
            ['导出文件名预览', previewFile],
            ['当前数据源', (s.exportSource === 'local' && format === 'jsonl') ? '本地直出 Blob（零网络拷贝）' : '服务端 /api/chats/export（失败回退本地）'],
            ['楼层口径明细', `界面 #${identity.floor}（0 起） / 总消息 ${identity.total ?? 0} 条 / 隐藏楼 ${identity.hidden ?? 0} 条 / 校准偏移 ${Number(s.floorOffset) || 0}`],
            ['当前计数键 (Key)', identity.key],
        ];
        if (counter.lastBackupFile) {
            kvs.push(['最近锚定文件', `${counter.lastBackupFile}（#${counter.lastFloor} 楼）`]);
        }
        for (const [k, v] of kvs) {
            const item = el('div', 'cab-kv-item');
            item.append(el('span', 'cab-kv-key', k), el('span', 'cab-kv-val', v));
            techKv.append(item);
        }
    }
}

function renderRecords(s, identity) {
    const countersBox = document.getElementById('cab_counters');
    const badge = document.getElementById('cab_records_badge');
    const summaryEl = document.getElementById('cab_records_summary');
    const pruneBtn = document.getElementById('cab_prune_btn');

    const entries = Object.entries(s.counters || {});
    const totalCount = entries.length;
    const inactiveCount = entries.filter(([, c]) => !c || (c.exports === 0 && !c.lastExportAt)).length;
    const exportedCount = totalCount - inactiveCount;

    if (badge) badge.textContent = String(totalCount);

    if (pruneBtn) {
        pruneBtn.textContent = '';
        pruneBtn.append(
            faIcon('fa-solid fa-broom'),
            el('span', '', inactiveCount ? `清理无效 (${inactiveCount})` : '无无效记录'),
        );
        pruneBtn.disabled = inactiveCount === 0;
    }

    if (!countersBox) return;
    countersBox.textContent = '';

    const q = uiState.searchQuery.toLowerCase();
    const filtered = entries.filter(([key, c]) => {
        if (!q) return true;
        const name = String(c?.name || '').toLowerCase();
        const chatPart = String(key).split(':').slice(2).join(':').toLowerCase();
        return name.includes(q) || chatPart.includes(q);
    });

    // 排序：当前会话置顶，其次按最近导出时间倒序、导出次数倒序、楼层倒序
    filtered.sort(([keyA, a], [keyB, b]) => {
        const activeA = keyA === identity?.key ? 1 : 0;
        const activeB = keyB === identity?.key ? 1 : 0;
        if (activeA !== activeB) return activeB - activeA;
        const timeA = String(a?.lastExportAt || '');
        const timeB = String(b?.lastExportAt || '');
        if (timeA !== timeB) return timeB.localeCompare(timeA);
        const expDiff = Number(b?.exports ?? 0) - Number(a?.exports ?? 0);
        if (expDiff !== 0) return expDiff;
        return Number(b?.lastFloor ?? 0) - Number(a?.lastFloor ?? 0);
    });

    if (summaryEl) {
        summaryEl.textContent = q
            ? `匹配 ${filtered.length} / ${totalCount} 条记录`
            : `共 ${totalCount} 条记录 · 已导出 ${exportedCount} 条`;
    }

    if (!totalCount) {
        const empty = el('div', 'cab-empty-card');
        empty.append(
            faIcon('fa-solid fa-inbox'),
            el('div', 'cab-empty-title', '暂无角色卡计数记录'),
            el('div', 'cab-empty-desc', '不同角色卡与会话的楼层计数完全隔离，推进聊天或手动备份后会自动建立。'),
        );
        countersBox.append(empty);
        return;
    }

    if (!filtered.length) {
        const empty = el('div', 'cab-empty-card');
        empty.append(
            faIcon('fa-solid fa-magnifying-glass'),
            el('div', 'cab-empty-title', '没有匹配的记录'),
            el('div', 'cab-empty-desc', `未找到包含「${uiState.searchQuery}」的角色卡或会话。`),
        );
        countersBox.append(empty);
        return;
    }

    const nowParts = getNowDateParts();
    const frag = document.createDocumentFragment();
    for (const [key, counter] of filtered) {
        const isCurrent = key === identity?.key;
        const isGroup = String(key).startsWith('group:');
        const cardName = counter?.name || '(未命名角色卡)';
        const rawChatId = String(key).split(':').slice(2).join(':');
        const session = formatChatSession(rawChatId, cardName);
        const timeInfo = formatReadableTime(counter?.lastExportAt, { compact: true, nowParts });
        const exportsCount = Number(counter?.exports ?? 0);
        const lastFloor = Number(counter?.lastFloor ?? 0);
        const backfilled = Number(counter?.backfilledFloor ?? 0);

        const item = el('div', 'cab-record-item' + (isCurrent ? ' is-active' : ''));

        // 第一行：角色卡名 + 标签 + 删除图标按钮（由容器事件委托处理点击）
        const top = el('div', 'cab-record-top');
        const titleWrap = el('div', 'cab-record-title-wrap');
        const nameEl = el('span', 'cab-record-name', cardName);
        nameEl.title = cardName;
        titleWrap.append(nameEl);
        if (isCurrent) titleWrap.append(el('span', 'cab-tag cab-tag-accent', '当前'));
        if (isGroup) titleWrap.append(el('span', 'cab-tag', '群聊'));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'cab-btn cab-btn-icon cab-record-del';
        delBtn.dataset.key = key;
        delBtn.title = '移除此条计数记录（不会删除已保存的文件）';
        delBtn.append(faIcon('fa-solid fa-trash-can'));
        top.append(titleWrap, delBtn);

        // 第二行：美化后的会话信息
        const sessRow = el('div', 'cab-record-session');
        const sessText = el('span', '', session.label || '—');
        sessText.title = rawChatId || key;
        sessRow.append(faIcon('fa-solid fa-clock'), sessText);
        if (session.imported) sessRow.append(el('span', 'cab-tag', '导入'));

        // 第三行：楼层/回溯/次数徽章 + 最近时间
        const meta = el('div', 'cab-record-meta');
        const stats = el('div', 'cab-record-stats');
        stats.append(
            el('span', 'cab-stat-pill', `上次 #${lastFloor}`),
            el('span', 'cab-stat-pill', `回溯 #${backfilled}`),
            el('span', 'cab-stat-pill' + (exportsCount > 0 ? ' is-highlight' : ''), `导出 ${exportsCount} 次`),
        );
        const timeEl = el('span', 'cab-record-time', timeInfo.text);
        if (timeInfo.full) timeEl.title = `精确时间：${timeInfo.full}`;
        meta.append(stats, timeEl);

        item.append(top, sessRow, meta);
        frag.append(item);
    }
    countersBox.append(frag);
}

function syncBusyUI(pending = null) {
    const nowBtn = document.getElementById('cab_now_btn');
    const backfillBtn = document.getElementById('cab_backfill_btn');
    const markBtn = document.getElementById('cab_mark_btn');
    const resetBtn = document.getElementById('cab_reset_btn');

    let segs = pending;
    if (segs === null) {
        try {
            segs = pendingSegments(currentIdentity(false), settings());
        } catch (e) {
            segs = [];
        }
    }
    const count = segs?.length ?? 0;

    if (nowBtn) {
        nowBtn.textContent = '';
        if (uiState.backingUp) {
            nowBtn.append(faIcon('fa-solid fa-spinner fa-spin'), el('span', '', '正在备份…'));
        } else {
            nowBtn.append(faIcon('fa-solid fa-floppy-disk'), el('span', '', '立即备份当前聊天'));
        }
        nowBtn.disabled = busy;
    }

    if (backfillBtn) {
        backfillBtn.textContent = '';
        if (uiState.backfillProgress) {
            const { current, total } = uiState.backfillProgress;
            backfillBtn.append(
                faIcon('fa-solid fa-spinner fa-spin'),
                el('span', '', `回溯补齐中 (${current}/${total})…`),
            );
        } else {
            backfillBtn.append(
                faIcon('fa-solid fa-clock-rotate-left'),
                el('span', '', count ? `回溯补齐（${count} 段）` : '回溯补齐历史'),
            );
        }
        backfillBtn.disabled = busy || count === 0;
        backfillBtn.title = count ? `按间隔补齐第 ${formatSegments(segs, 12)} 楼` : '没有待回溯的历史段落';
    }

    if (markBtn) markBtn.disabled = busy || count === 0;
    if (resetBtn) resetBtn.disabled = busy;
}

function scheduleRefresh({ force = false, tab = null } = {}) {
    if (!document.getElementById('chat_autobackup_container')) return;
    if (force) panelDirty = true;
    if (!isDrawerOpen()) {
        try {
            syncHeaderDot(settings());
        } catch (e) {
            // 忽略未就绪时的圆点更新错误
        }
        panelDirty = true;
        return;
    }
    if (refreshRafId) return;
    const raf = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16);
    refreshRafId = raf(() => {
        refreshRafId = 0;
        refreshPanel({ onlyTab: tab, forceRender: true });
    });
}

function refreshPanel({ onlyTab = null, forceRender = false } = {}) {
    if (!document.getElementById('chat_autobackup_container')) return;

    let s;
    try {
        s = settings();
    } catch (e) {
        return;
    }

    syncHeaderDot(s);
    if (!forceRender && !isDrawerOpen()) {
        panelDirty = true;
        return;
    }

    const activeTab = onlyTab || uiState.activeTab;
    let identity;
    try {
        identity = currentIdentity(activeTab === 'overview');
    } catch (e) {
        return;
    }

    syncTopbarAndSettings(s, identity, { syncSettingsTab: activeTab === 'settings' || forceRender });

    const badge = document.getElementById('cab_records_badge');
    if (badge) badge.textContent = String(Object.keys(s.counters || {}).length);

    if (activeTab === 'overview') {
        const pending = hasActiveChat(identity) ? pendingSegments(identity, s) : [];
        renderOverview(s, identity, pending);
        syncBusyUI(pending);
    } else if (activeTab === 'records') {
        renderRecords(s, identity);
    }
    panelDirty = false;
}

/* ------------------------------------------------------------------ *
 * 事件与自举
 * ------------------------------------------------------------------ */

function registerEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (msgId) => onChatActivity('ai', msgId));
    eventSource.on(eventTypes.MESSAGE_SENT, (msgId) => onChatActivity('user', msgId));
    if (eventTypes.MESSAGE_SWIPED) {
        eventSource.on(eventTypes.MESSAGE_SWIPED, (msgId) => onChatActivity('swipe', msgId));
    }
    if (eventTypes.MESSAGE_EDITED) {
        eventSource.on(eventTypes.MESSAGE_EDITED, (msgId) => onChatActivity('edit', msgId));
    }
    if (eventTypes.MESSAGE_DELETED) {
        eventSource.on(eventTypes.MESSAGE_DELETED, (msgId) => onChatActivity('delete', msgId));
    }
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        cancelPendingRewrite();
        uiState.deferredReason = '';
        uiState.deferredKey = '';
        scheduleRefresh();
    });
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => scheduleRefresh());
    log('事件已注册：MESSAGE_RECEIVED / MESSAGE_SENT / MESSAGE_SWIPED / MESSAGE_EDITED / MESSAGE_DELETED / CHAT_CHANGED');
}

function registerSlashCommand() {
    try {
        const context = ctx();
        const parser = context.SlashCommandParser;
        if (!parser?.addCommandObject) return;
        parser.addCommandObject(parser.command('cabackup', {
            helpString: '手动触发一次聊天记录备份（可选参数 interval=楼层数 修改间隔）',
            unnamedArgumentParser: null,
            callback: async (_args, value) => {
                const match = /interval\s*=\s*(\d+)/i.exec(String(value ?? ''));
                if (match) {
                    settings().interval = Math.max(1, parseInt(match[1], 10) || 1);
                    saveSettings();
                    refreshPanel();
                    return `导出间隔已设为每 ${settings().interval} 楼一次`;
                }
                await runBackup({ manual: true });
                return '备份已触发';
            },
        }));
        log('斜杠命令 /cabackup 已注册');
    } catch (e) {
        log('斜杠命令注册失败（可忽略）', e);
    }
}

function onReady() {
    try {
        console.info(`[${MODULE_NAME}] v${EXT_VERSION} 已加载（若与 manifest 版本不符说明浏览器缓存了旧代码，请 Ctrl+F5 强制刷新）`);
        settings();
        buildPanel();
        registerEvents();
        registerSlashCommand();
        log('初始化完成');
    } catch (e) {
        console.error(`[${MODULE_NAME}] 初始化失败`, e);
    }
}

(function bootstrap() {
    try {
        const context = ctx();
        const { eventSource, eventTypes } = context;
        if (eventSource?.once && eventTypes?.APP_READY) {
            eventSource.once(eventTypes.APP_READY, onReady);
        } else {
            onReady();
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] bootstrap failed`, e);
    }
})();

// 供调试使用
window.chatAutoBackup = {
    runBackup,
    runBackfill,
    refreshPanel,
    scheduleRefresh,
    settings,
    currentIdentity,
    onChatActivity,
    isMessageEmpty,
    messageFingerprint,
};
