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
const EXT_VERSION = '1.1.4';
const IDB_NAME = 'chat-autobackup';
const IDB_STORE = 'handles';
const IDB_KEY_ROOT = 'backupRoot';
const SEPARATOR = '——';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,          // 总开关
    interval: 50,           // 每 X 楼导出一次
    format: 'jsonl',        // jsonl | txt
    countMode: 'all',       // all = 用户楼+AI楼都计数；ai = 只在 AI 出楼层后计数
    writeMode: 'fsa',       // fsa = 写入授权目录（按卡分文件夹）；download = 浏览器下载
    saveBeforeExport: true, // 导出前先 saveChat，保证服务端 jsonl 是最新的
    toast: true,            // 导出完成提示
    onConflict: 'suffix',   // suffix = 同名追加序号；overwrite = 覆盖
    folderDepth: 'card_chat',        // card_chat = 角色卡/聊天；card = 角色卡；chat = 聊天；none = 平铺
    chatFolderName: 'created',       // created = 角色卡名.聊天创建日期（2026.9.1）；chatid = 聊天文件名；datetime = 导出时间戳
    downloadIncludeChat: true,       // 下载模式下把聊天名并入文件名，避免同卡多聊天混淆
    floorOffset: 0,          // 楼号校准：面板楼号与界面楼号差多少就填多少（界面小 2 就填 -2）
    swallowHidden: 0,        // 切片时最多额外吞并目标楼之后的连续隐藏楼条数（0 = 一个都不带）
    counters: {},           // { [key]: { name, lastFloor, exports, lastExportAt } }
    rootName: '',           // 已授权根目录名（仅用于展示）
});

let busy = false;

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
    // 补齐新增字段，不覆盖用户已有值
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = (k === 'counters') ? {} : v;
    }
    if (!s.counters || typeof s.counters !== 'object') s.counters = {};
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

function currentIdentity() {
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
    const hidden = countHidden(context.chat);
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

/**
 * 切片终点：截止到楼号 target（含）=> 索引 [0, target+1)。
 * 可选向后吞并紧随的隐藏楼，但有硬上限（默认 0，绝不吞并）：
 * 星光旅途这类 MVU 卡会连续注入上百条隐藏楼，无上限吞并会把 50 楼的切片膨胀成整档。
 */
function sliceEnd(messages, target) {
    const len = Array.isArray(messages) ? messages.length : 0;
    if (len === 0) return 0;
    const cap = Math.max(0, Math.min(50, Number(settings().swallowHidden) || 0));
    let end = Math.max(0, Math.min(Number(target) + 1, len));
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
        s.counters[key] = { name: '', lastFloor: 0, backfilledFloor: 0, exports: 0, lastExportAt: '' };
    }
    if (s.counters[key].backfilledFloor === undefined) s.counters[key].backfilledFloor = 0;
    return s.counters[key];
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
    const counter = getCounter(identity.key);
    const isFirstSeen = !counter.lastFloor && counter.exports === 0 && !counter.lastExportAt;

    if (isFirstSeen) {
        const interval = intervalValue(s);
        counter.lastFloor = Math.floor(identity.floor / interval) * interval;
        counter.name = identity.cardName;
        saveSettings();
        log(`初始化计数基线 key=${identity.key} floor=${identity.floor} → 基线 ${counter.lastFloor}`);
        return false;
    }

    // 聊天被回退/删楼层：基线高于当前楼层时重置基线，避免永远触发或永远不触发
    if (identity.floor < counter.lastFloor) {
        counter.lastFloor = identity.floor;
        saveSettings();
        return false;
    }

    return (identity.floor - counter.lastFloor) >= intervalValue(s);
}

/**
 * 待回溯的历史段落：从「已回溯楼层」往上一个间隔开始，到「当前楼层向下取整的间隔倍数」为止。
 * 例：当前 438 楼、间隔 50、从未回溯 → [50, 100, 150, 200, 250, 300, 350, 400]
 * 例：已回溯到 300 楼、当前 438 楼 → [350, 400]
 */
function pendingSegments(identity, s = settings()) {
    const interval = intervalValue(s);
    const counter = getCounter(identity.key);
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

function remainingFloors(identity) {
    const counter = getCounter(identity.key);
    if (!counter.lastFloor) return Math.max(1, Number(settings().interval) || 1);
    const interval = Math.max(1, Number(settings().interval) || 1);
    return Math.max(0, interval - (identity.floor - counter.lastFloor));
}

/* ------------------------------------------------------------------ *
 * 导出内容：服务端 /api/chats/export 优先，前端序列化回退
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

/**
 * 序列化当前聊天。
 * @param {string} format jsonl | txt
 * @param {number|null} uptoFloor 截止的界面楼号（含该楼）。null = 整档。
 *   截断点 = 楼号 + 1；隐藏楼吞并量由「切片带隐藏楼」设置项控制（默认 0）。
 *   jsonl 会在首行补元数据表头，保证回导入后楼层号不偏移。
 */
function serializeLocalChat(format, uptoFloor = null, identity = null) {
    const context = ctx();
    const all = Array.isArray(context.chat) ? context.chat : [];
    let messages = all;
    if (uptoFloor !== null) {
        messages = all.slice(0, sliceEnd(all, uptoFloor).end);
    }
    if (format === 'txt') {
        return messages
            .filter((m) => !m?.is_system)
            .map((m) => `${m?.name ?? '?'}: ${String(m?.extra?.display_text ?? m?.mes ?? '').replace(/\r?\n/g, '\n')}`)
            .join('\n\n') + '\n';
    }
    const body = messages.map((m) => JSON.stringify(m)).join('\n');
    const header = buildHeaderLine(identity ?? currentIdentity());
    return `${header}\n${body}\n`;
}

async function buildExportContent(format) {
    try {
        return { content: await fetchServerExport(format), source: 'server' };
    } catch (e) {
        log('服务端导出失败，回退本地序列化', e);
        return { content: serializeLocalChat(format, null, currentIdentity()), source: 'local' };
    }
}

/* ------------------------------------------------------------------ *
 * 落盘：File System Access API（按角色卡分文件夹） / 浏览器下载回退
 * ------------------------------------------------------------------ */

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
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
    await idbSet(IDB_KEY_ROOT, handle);
    settings().rootName = handle.name || '已授权目录';
    saveSettings();
    refreshPanel();
    return handle;
}

async function getRootHandle() {
    const handle = await idbGet(IDB_KEY_ROOT);
    if (!handle) return null;
    try {
        const permission = await handle.queryPermission?.({ mode: 'readwrite' });
        if (permission === 'granted') return handle;
    } catch (e) {
        log('queryPermission failed', e);
    }
    return handle; // 权限待确认，写入时再请求
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

/**
 * 写入 <根目录>/<角色卡文件夹>/<文件名>
 * 不同角色卡的文件夹名不同，天然隔离。
 */
async function writeViaFsa(handle, segments, fileName, content) {
    if (!(await ensurePermission(handle))) throw new Error('FSA_PERMISSION_DENIED');
    let dir = handle;
    for (const segment of segments) {
        dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    let target = fileName;
    if (settings().onConflict === 'suffix') {
        let index = 1;
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

    const fileHandle = await dir.getFileHandle(target, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return target;
}

function withSuffix(fileName, index) {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return `${fileName} (${index})`;
    return `${fileName.slice(0, dot)} (${index})${fileName.slice(dot)}`;
}

function writeViaDownload(fileName, content, format) {
    const type = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/jsonl;charset=utf-8';
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return fileName;
}

/* ------------------------------------------------------------------ *
 * 备份主流程
 * ------------------------------------------------------------------ */

async function runBackup({ manual = false } = {}) {
    if (busy) {
        log('上一次备份尚未结束，跳过本次触发');
        return { ok: false, reason: 'busy' };
    }
    busy = true;
    try {
        const s = settings();
        const identity = currentIdentity();
        const format = s.format === 'txt' ? 'txt' : 'jsonl';
        const dirFileName = buildFileName(identity, format, false);
        const downloadName = buildFileName(identity, format, true);
        const segments = backupPathSegments(identity);

        const { content, source } = await buildExportContent(format);

        let savedAs = downloadName;
        let mode = 'download';

        if (s.writeMode === 'fsa' && fsaSupported()) {
            const handle = await getRootHandle();
            if (handle) {
                try {
                    savedAs = await writeViaFsa(handle, segments, dirFileName, content);
                    mode = 'fsa';
                } catch (e) {
                    log('FSA 写入失败，回退浏览器下载', e);
                    savedAs = writeViaDownload(downloadName, content, format);
                    mode = 'download';
                }
            } else {
                savedAs = writeViaDownload(downloadName, content, format);
                mode = 'download';
            }
        } else {
            savedAs = writeViaDownload(downloadName, content, format);
        }

        const counter = getCounter(identity.key);
        counter.name = identity.cardName;
        counter.lastFloor = identity.floor;
        counter.exports = (counter.exports || 0) + 1;
        counter.lastExportAt = timestampSlug();
        saveSettings();

        const place = mode === 'fsa'
            ? [s.rootName || '备份根目录', ...segments].join('\\') + '\\'
            : '浏览器下载目录';
        const message = `已备份 ${identity.cardName} 第 ${identity.floor} 楼 → ${place}${savedAs}${source === 'local' ? '（本地序列化回退）' : ''}`;
        log(message);
        notify(manual ? `手动备份完成：${savedAs}` : message, 'success');
        refreshPanel();
        return { ok: true, mode, savedAs, identity };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 备份失败`, e);
        notify(`备份失败：${e?.message || e}`, 'error');
        return { ok: false, reason: e?.message || String(e) };
    } finally {
        busy = false;
    }
}

/**
 * 回溯备份：按导出间隔把「已加载的历史楼层」逐段补齐。
 * 例：当前 438 楼、间隔 50、从未备份 → 导出 50 / 100 / 150 / … / 400 共 8 个文件。
 *
 * 说明：服务端 /api/chats/export 只能整档导出，无法切片，
 * 因此回溯一律使用前端 context.chat.slice(0, n) 序列化（字段与 jsonl 原文一致）。
 */
async function runBackfill() {
    if (busy) {
        notify('上一次备份尚未结束，请稍候', 'warning');
        return { ok: false, reason: 'busy' };
    }

    const s = settings();
    let identity;
    try {
        identity = currentIdentity();
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
    const format = s.format === 'txt' ? 'txt' : 'jsonl';
    const pathSegments = backupPathSegments(identity);
    let handle = null;
    if (s.writeMode === 'fsa' && fsaSupported()) handle = await getRootHandle();

    let done = 0;
    let lastOk = Number(getCounter(identity.key).backfilledFloor ?? 0);
    const written = [];

    try {
        for (const target of floors) {
            try {
                // 切片导出（独立实现 + 硬校验）：
                // 截止楼号 target（含），向后吞并紧随的隐藏楼；写入前校验行数，异常即拒绝写盘。
                const all = Array.isArray(ctx().chat) ? ctx().chat : [];
                const { end, swallowed } = sliceEnd(all, target);
                if (end <= target) throw new Error(`切片越界：end=${end} ≤ target=${target}（共 ${all.length} 条）`);

                let content;
                if (format === 'txt') {
                    content = all.slice(0, end)
                        .filter((m) => !m?.is_system)
                        .map((m) => `${m?.name ?? '?'}: ${String(m?.extra?.display_text ?? m?.mes ?? '').replace(/\r?\n/g, '\n')}`)
                        .join('\n\n') + '\n';
                } else {
                    // 与酒馆原生导出结构一致：首行元数据表头 + 消息体，回导入后楼层号不偏移
                    const body = all.slice(0, end).map((m) => JSON.stringify(m)).join('\n');
                    content = `${buildHeaderLine(identity)}\n${body}\n`;
                }

                // 硬校验：实际条数必须等于「目标楼 + 1 + 允许吞并的隐藏楼上限」
                const actualLines = end;
                const maxAllowed = target + 1 + Math.max(0, Math.min(50, Number(s.swallowHidden) || 0));
                if (actualLines > maxAllowed) {
                    throw new Error(`切片自检失败：目标 ${target} 楼，实际切出 ${actualLines} 条（上限 ${maxAllowed}，总 ${all.length} 条）— 拒绝写入`);
                }
                log(`回溯 ${target} 楼：切出 ${actualLines}/${all.length} 条，${content.length} 字符`);

                const dirName = buildFileName(identity, format, false, target);
                const dlName = buildFileName(identity, format, true, target);

                let savedAs;
                if (handle) {
                    try {
                        savedAs = await writeViaFsa(handle, pathSegments, dirName, content);
                    } catch (e) {
                        log('回溯：FSA 写入失败，回退下载', e);
                        savedAs = writeViaDownload(dlName, content, format);
                    }
                } else {
                    savedAs = writeViaDownload(dlName, content, format);
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
        refreshPanel();
        return { ok: true, done, lastOk };
    } catch (e) {
        console.error(`[${MODULE_NAME}] 回溯备份失败`, e);
        notify(`回溯备份失败：${e?.message || e}`, 'error');
        return { ok: false, reason: e?.message || String(e) };
    } finally {
        busy = false;
    }
}

/** 把历史空档标记为已备份（不生成文件） */
function markBackfilled(identity) {
    const counter = getCounter(identity.key);
    const interval = intervalValue();
    counter.backfilledFloor = Math.floor(identity.floor / interval) * interval;
    counter.name = identity.cardName;
    saveSettings();
    refreshPanel();
    notify(`已把「${identity.cardName}」的历史空档标记为已备份（至 ${counter.backfilledFloor} 楼）`, 'info');
}

async function onFloorAdvance(trigger) {
    try {
        const s = settings();
        if (!s.enabled) return;
        if (s.countMode === 'ai' && trigger !== 'ai') return;

        const identity = currentIdentity();

        if (shouldExport(identity)) {
            log(`触发自动备份 key=${identity.key} floor=${identity.floor} interval=${s.interval}`);
            await runBackup();
        } else {
            refreshPanel();
        }
    } catch (e) {
        console.error(`[${MODULE_NAME}] 楼层计数处理失败`, e);
    }
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

function panelHost() {
    return document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
}

function buildPanel() {
    if (document.getElementById('chat_autobackup_container')) return;
    const host = panelHost();
    if (!host) {
        log('未找到扩展设置容器，稍后重试');
        return;
    }

    const container = document.createElement('div');
    container.id = 'chat_autobackup_container';
    container.className = 'chat-autobackup-container';

    const drawer = document.createElement('div');
    drawer.className = 'inline-drawer';

    const header = document.createElement('div');
    header.className = 'inline-drawer-toggle inline-drawer-header';
    const title = document.createElement('b');
    title.textContent = `聊天记录自动备份 (Chat Auto Backup) v${EXT_VERSION}`;
    const icon = document.createElement('div');
    icon.className = 'inline-drawer-icon fa-solid fa-circle-chevron-down down';
    header.append(title, icon);

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';
    content.id = 'chat_autobackup_content';

    drawer.append(header, content);
    container.append(drawer);
    host.append(container);

    header.addEventListener('click', () => drawer.classList.toggle('open'));

    renderControls(content);
    refreshPanel();
}

function makeRow(labelText, hintText) {
    const row = document.createElement('div');
    row.className = 'cab-row';
    const label = document.createElement('label');
    label.className = 'cab-label';
    label.textContent = labelText;
    if (hintText) {
        const hint = document.createElement('small');
        hint.className = 'cab-hint';
        hint.textContent = hintText;
        label.append(hint);
    }
    row.append(label);
    return row;
}

function renderControls(root) {
    const s = settings();

    // 启用开关
    const enableRow = makeRow('启用自动备份');
    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = s.enabled;
    enableBox.addEventListener('change', () => {
        settings().enabled = enableBox.checked;
        saveSettings();
    });
    enableRow.append(enableBox);
    root.append(enableRow);

    // 楼层间隔
    const intervalRow = makeRow('导出间隔（楼）', '每新增这么多楼层就导出一次；每个角色卡独立计数');
    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.min = '1';
    intervalInput.step = '1';
    intervalInput.className = 'text_pole cab-number';
    intervalInput.value = s.interval;
    intervalInput.addEventListener('change', () => {
        const value = Math.max(1, parseInt(intervalInput.value, 10) || 1);
        settings().interval = value;
        intervalInput.value = value;
        saveSettings();
        refreshPanel();
    });
    intervalRow.append(intervalInput);
    root.append(intervalRow);

    // 格式
    const formatRow = makeRow('导出格式', 'jsonl 可回导入酒馆；txt 便于直接阅读');
    const formatSelect = document.createElement('select');
    formatSelect.className = 'text_pole cab-select';
    for (const [value, text] of [['jsonl', 'JSONL（可回导入）'], ['txt', 'TXT（纯文本阅读）']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        formatSelect.append(option);
    }
    formatSelect.value = s.format;
    formatSelect.addEventListener('change', () => {
        settings().format = formatSelect.value;
        saveSettings();
    });
    formatRow.append(formatSelect);
    root.append(formatRow);

    // 计数模式
    const countRow = makeRow('计数方式', '全部楼层：用户与 AI 各算一楼；仅 AI 楼层：一轮算一楼');
    const countSelect = document.createElement('select');
    countSelect.className = 'text_pole cab-select';
    for (const [value, text] of [['all', '全部楼层'], ['ai', '仅 AI 楼层']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        countSelect.append(option);
    }
    countSelect.value = s.countMode;
    countSelect.addEventListener('change', () => {
        settings().countMode = countSelect.value;
        saveSettings();
    });
    countRow.append(countSelect);
    root.append(countRow);

    // 写入方式
    const writeRow = makeRow('保存方式', '目录写入需授权一次根目录，之后自动按角色卡建子文件夹');
    const writeSelect = document.createElement('select');
    writeSelect.className = 'text_pole cab-select';
    for (const [value, text] of [['fsa', '写入授权目录（按卡分文件夹）'], ['download', '浏览器下载']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        writeSelect.append(option);
    }
    writeSelect.value = s.writeMode;
    writeSelect.addEventListener('change', () => {
        settings().writeMode = writeSelect.value;
        saveSettings();
        refreshPanel();
    });
    writeRow.append(writeSelect);
    root.append(writeRow);

    // 目录授权
    const dirRow = makeRow('备份根目录', '未授权时自动回退为浏览器下载');
    const dirBox = document.createElement('div');
    dirBox.className = 'cab-inline';
    const dirLabel = document.createElement('span');
    dirLabel.id = 'cab_root_label';
    dirLabel.className = 'cab-mono';
    const pickBtn = document.createElement('button');
    pickBtn.className = 'menu_button cab-btn';
    pickBtn.textContent = '选择目录';
    pickBtn.addEventListener('click', async () => {
        try {
            await pickBackupRoot();
            notify('备份根目录已授权', 'success');
        } catch (e) {
            log('选择目录取消或失败', e);
        }
    });
    const clearBtn = document.createElement('button');
    clearBtn.className = 'menu_button cab-btn';
    clearBtn.textContent = '清除';
    clearBtn.addEventListener('click', async () => {
        await idbDelete(IDB_KEY_ROOT);
        settings().rootName = '';
        saveSettings();
        refreshPanel();
    });
    dirBox.append(dirLabel, pickBtn, clearBtn);
    dirRow.append(dirBox);
    root.append(dirRow);

    // 目录层级
    const depthRow = makeRow('目录层级', '默认：角色卡 / 聊天记录，同一张卡的不同聊天各自独立');
    const depthSelect = document.createElement('select');
    depthSelect.className = 'text_pole cab-select';
    for (const [value, text] of [
        ['card_chat', '角色卡 / 聊天记录'],
        ['card', '仅角色卡'],
        ['chat', '仅聊天记录'],
        ['none', '平铺到根目录'],
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
    depthRow.append(depthSelect);
    root.append(depthRow);

    // 聊天文件夹命名
    const chatFolderRow = makeRow('聊天文件夹命名', '创建日期取首楼时间，例：星野光.2026.9.1');
    const chatFolderSelect = document.createElement('select');
    chatFolderSelect.className = 'text_pole cab-select';
    for (const [value, text] of [
        ['created', '角色卡名.创建日期（推荐）'],
        ['chatid', '聊天文件名'],
        ['datetime', '导出时间戳（每次新建）'],
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
    chatFolderRow.append(chatFolderSelect);
    root.append(chatFolderRow);

    // 下载文件名是否含聊天名
    const dlRow = makeRow('下载文件名含聊天名', '仅影响浏览器下载模式：角色卡——聊天名——USER——楼层数');
    const dlBox = document.createElement('input');
    dlBox.type = 'checkbox';
    dlBox.checked = s.downloadIncludeChat;
    dlBox.addEventListener('change', () => {
        settings().downloadIncludeChat = dlBox.checked;
        saveSettings();
    });
    dlRow.append(dlBox);
    root.append(dlRow);

    // 楼号校准（界面楼号与数组索引不一致时用）
    const offRow = makeRow('楼号校准', '默认 0 = 与界面 #N（0 起）一致。你的卡状态栏若按 1 起的条数显示楼层数，填 +1 即可对齐；界面比面板小 N 则填 -N');
    const offInput = document.createElement('input');
    offInput.type = 'number';
    offInput.className = 'text_pole cab-num';
    offInput.step = '1';
    offInput.value = String(Number(s.floorOffset) || 0);
    offInput.addEventListener('change', () => {
        settings().floorOffset = Math.max(-999, Math.min(999, Number(offInput.value) || 0));
        saveSettings();
        refreshPanel();
    });
    offRow.append(offInput);
    root.append(offRow);

    // 切片尾随隐藏楼
    const swRow = makeRow('切片带隐藏楼', '目标楼之后连续的隐藏楼（脚本变量楼）最多额外带几条；0 = 一条都不带。设大了会把小切片膨胀成整档');
    const swInput = document.createElement('input');
    swInput.type = 'number';
    swInput.className = 'text_pole cab-num';
    swInput.min = '0';
    swInput.max = '50';
    swInput.step = '1';
    swInput.value = String(Number(s.swallowHidden) || 0);
    swInput.addEventListener('change', () => {
        settings().swallowHidden = Math.max(0, Math.min(50, Number(swInput.value) || 0));
        saveSettings();
        refreshPanel();
    });
    swRow.append(swInput);
    root.append(swRow);

    // 同名处理
    const conflictRow = makeRow('同名文件', '追加序号可保留每次备份的历史版本');
    const conflictSelect = document.createElement('select');
    conflictSelect.className = 'text_pole cab-select';
    for (const [value, text] of [['suffix', '追加序号 (2)(3)'], ['overwrite', '覆盖']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        conflictSelect.append(option);
    }
    conflictSelect.value = s.onConflict;
    conflictSelect.addEventListener('change', () => {
        settings().onConflict = conflictSelect.value;
        saveSettings();
    });
    conflictRow.append(conflictSelect);
    root.append(conflictRow);

    // 提示开关
    const toastRow = makeRow('导出后提示');
    const toastBox = document.createElement('input');
    toastBox.type = 'checkbox';
    toastBox.checked = s.toast;
    toastBox.addEventListener('change', () => {
        settings().toast = toastBox.checked;
        saveSettings();
    });
    toastRow.append(toastBox);
    root.append(toastRow);

    // 状态区
    const statusTitle = document.createElement('div');
    statusTitle.className = 'cab-section-title';
    statusTitle.textContent = '当前聊天';
    root.append(statusTitle);

    const statusBox = document.createElement('div');
    statusBox.id = 'cab_status';
    statusBox.className = 'cab-status';
    root.append(statusBox);

    // 操作按钮
    const actionRow = document.createElement('div');
    actionRow.className = 'cab-actions';

    const nowBtn = document.createElement('button');
    nowBtn.className = 'menu_button cab-btn';
    nowBtn.textContent = '立即备份当前聊天';
    nowBtn.addEventListener('click', () => runBackup({ manual: true }));
    actionRow.append(nowBtn);

    const backfillBtn = document.createElement('button');
    backfillBtn.id = 'cab_backfill_btn';
    backfillBtn.className = 'menu_button cab-btn';
    backfillBtn.textContent = '回溯备份历史段落';
    backfillBtn.addEventListener('click', () => runBackfill());
    actionRow.append(backfillBtn);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'menu_button cab-btn';
    resetBtn.textContent = '重置本卡计数';
    resetBtn.addEventListener('click', () => {
        try {
            const identity = currentIdentity();
            const s2 = settings();
            s2.counters[identity.key] = {
                name: identity.cardName,
                lastFloor: identity.floor,
                backfilledFloor: s2.counters[identity.key]?.backfilledFloor ?? 0,
                exports: s2.counters[identity.key]?.exports ?? 0,
                lastExportAt: s2.counters[identity.key]?.lastExportAt ?? '',
            };
            saveSettings();
            refreshPanel();
            notify(`已把「${identity.cardName}」的计数基线重置为当前 ${identity.floor} 楼`, 'success');
        } catch (e) {
            console.error(`[${MODULE_NAME}] 重置计数失败`, e);
        }
    });
    actionRow.append(resetBtn);

    const pruneBtn = document.createElement('button');
    pruneBtn.className = 'menu_button cab-btn';
    pruneBtn.textContent = '清理无效计数';
    pruneBtn.addEventListener('click', () => {
        const s2 = settings();
        const before = Object.keys(s2.counters).length;
        for (const [key, counter] of Object.entries(s2.counters)) {
            if (!counter || (counter.exports === 0 && !counter.lastExportAt)) delete s2.counters[key];
        }
        saveSettings();
        refreshPanel();
        notify(`已清理 ${before - Object.keys(s2.counters).length} 条从未导出过的计数记录`, 'info');
    });
    actionRow.append(pruneBtn);

    const markBtn = document.createElement('button');
    markBtn.id = 'cab_mark_btn';
    markBtn.className = 'menu_button cab-btn';
    markBtn.textContent = '忽略历史空档';
    markBtn.addEventListener('click', () => {
        try {
            markBackfilled(currentIdentity());
        } catch (e) {
            console.error(`[${MODULE_NAME}] 标记历史空档失败`, e);
        }
    });
    actionRow.append(markBtn);

    root.append(actionRow);

    // 计数表
    const tableTitle = document.createElement('div');
    tableTitle.className = 'cab-section-title';
    tableTitle.textContent = '各角色卡计数（相互隔离）';
    root.append(tableTitle);

    const tableWrap = document.createElement('div');
    tableWrap.id = 'cab_counters';
    tableWrap.className = 'cab-counters';
    root.append(tableWrap);
}

function refreshPanel() {
    const rootLabel = document.getElementById('cab_root_label');
    const statusBox = document.getElementById('cab_status');
    const countersBox = document.getElementById('cab_counters');
    if (!statusBox && !countersBox && !rootLabel) return;

    let s;
    let identity;
    try {
        s = settings();
        identity = currentIdentity();
    } catch (e) {
        return;
    }

    const pending = pendingSegments(identity, s);

    if (rootLabel) {
        rootLabel.textContent = s.writeMode === 'fsa'
            ? (s.rootName ? `已授权：${s.rootName}` : (fsaSupported() ? '未授权（将回退下载）' : '浏览器不支持目录写入'))
            : '浏览器下载模式';
    }

    if (statusBox) {
        statusBox.textContent = '';
        const counter = getCounter(identity.key);
        const pathSegments = backupPathSegments(identity);
        const rows = [
            ['角色卡', identity.cardName],
            ['聊天记录', identity.chatId || '—'],
            ['USER 名称', identity.userName],
            ['当前楼层（同界面 #N，0 起）', String(identity.floor)],
            ['消息总条数 / 隐藏楼', `${identity.total ?? 0} 条（1 起计数） / ${identity.hidden ?? 0} 条隐藏`],
            ['上次导出楼层', String(counter.lastFloor ?? 0)],
            ['已回溯至', `${counter.backfilledFloor ?? 0} 楼`],
            ['待回溯段落', pending.length ? `${pending.length} 段：${formatSegments(pending, 8)}` : '无'],
            ['距下次导出', `${remainingFloors(identity)} 楼`],
            ['本卡累计导出', `${counter.exports ?? 0} 次`],
            ['上次导出时间', counter.lastExportAt || '—'],
            ['目标文件夹', s.writeMode === 'fsa'
                ? [s.rootName || '备份根目录', ...pathSegments].join('\\') || '备份根目录'
                : '浏览器下载目录'],
            ['计数键', identity.key],
        ];
        for (const [k, v] of rows) {
            const line = document.createElement('div');
            line.className = 'cab-status-line';
            const key = document.createElement('span');
            key.className = 'cab-status-key';
            key.textContent = `${k}：`;
            const value = document.createElement('span');
            value.className = 'cab-status-value cab-mono';
            value.textContent = v;
            line.append(key, value);
            statusBox.append(line);
        }
    }

    if (countersBox) {
        countersBox.textContent = '';
        const entries = Object.entries(s.counters || {});
        if (!entries.length) {
            const empty = document.createElement('div');
            empty.className = 'cab-empty';
            empty.textContent = '暂无计数记录，聊天推进后自动建立。';
            countersBox.append(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'cab-table';
            const thead = document.createElement('thead');
            const headRow = document.createElement('tr');
            for (const text of ['角色卡', '聊天记录', '上次导出楼层', '已回溯至', '累计导出', '上次导出时间', '']) {
                const th = document.createElement('th');
                th.textContent = text;
                headRow.append(th);
            }
            thead.append(headRow);
            table.append(thead);

            const tbody = document.createElement('tbody');
            for (const [key, counter] of entries) {
                const tr = document.createElement('tr');
                if (key === identity.key) tr.className = 'cab-active';
                const chatLabel = String(key).split(':').slice(2).join(':') || '—';
                const values = [
                    counter?.name || '(未命名)',
                    chatLabel,
                    String(counter?.lastFloor ?? 0),
                    `${counter?.backfilledFloor ?? 0} 楼`,
                    `${counter?.exports ?? 0} 次`,
                    counter?.lastExportAt || '—',
                ];
                for (const text of values) {
                    const td = document.createElement('td');
                    td.textContent = text;
                    tr.append(td);
                }
                const tdOps = document.createElement('td');
                const del = document.createElement('button');
                del.className = 'menu_button cab-btn cab-btn-mini';
                del.textContent = '删除';
                del.addEventListener('click', () => {
                    delete settings().counters[key];
                    saveSettings();
                    refreshPanel();
                });
                tdOps.append(del);
                tr.append(tdOps);
                tbody.append(tr);
            }
            table.append(tbody);
            countersBox.append(table);
        }
    }

    updateBackfillButton(pending);
}

function updateBackfillButton(pending) {
    const btn = document.getElementById('cab_backfill_btn');
    if (!btn) return;
    const count = pending?.length ?? 0;
    btn.textContent = count ? `回溯备份历史段落（${count} 段）` : '回溯备份历史段落';
    btn.disabled = count === 0;
    btn.title = count ? `将导出第 ${formatSegments(pending, 12)} 楼` : '没有待回溯的历史段落';
}

/* ------------------------------------------------------------------ *
 * 事件与自举
 * ------------------------------------------------------------------ */

function registerEvents() {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => onFloorAdvance('ai'));
    eventSource.on(eventTypes.MESSAGE_SENT, () => onFloorAdvance('user'));
    eventSource.on(eventTypes.CHAT_CHANGED, () => refreshPanel());
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => refreshPanel());
    log('事件已注册：MESSAGE_RECEIVED / MESSAGE_SENT / CHAT_CHANGED');
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
window.chatAutoBackup = { runBackup, refreshPanel, settings, currentIdentity };
