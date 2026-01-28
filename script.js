// ==========================================
// script.js - 终极修复版 V5.8 (月度浏览渲染优化)
// ==========================================

// 动态加载 Supabase SDK
const script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
document.head.appendChild(script);

// 全局状态
let state = {
    currentDate: new Date(),
    selectedDate: new Date(),
    diaryData: {}, 
    todoData: [],
    settings: { 
        theme: "theme-beige", 
        paper: "paper-lines", 
        darkMode: false, 
        customFont: "", 
        showTodo: true, 
        enableSticker: false, 
        cloudUrl: "", 
        cloudKey: ""
    },
    security: { enabled: false, pin: "", biometrics: false, credentialId: null },
    bgImage: null, 
    isDirty: false
};

let supabaseClient = null;
let isEditingDrawer = false;
let globalMaxZIndex = 100; 

// === 贴纸锁定状态控制 ===
let isStickersLocked = true; // 默认锁定：只能写字，不能动贴纸

// ==========================================
// 数据库 (AppDB)
// ==========================================
const AppDB = {
    dbName: 'MyDiaryProDB',
    dbVersion: 2, 
    db: null,
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'date' });
                if (!db.objectStoreNames.contains('stickers')) db.createObjectStore('stickers', { keyPath: 'id', autoIncrement: true });
                if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
            };
            request.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            request.onerror = (e) => reject(e);
        });
    },
    async loadAllEntries() {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['entries'], 'readonly');
            const req = tx.objectStore('entries').getAll();
            req.onsuccess = () => { const r={}; req.result.forEach(i=>{r[i.date]=i.content}); resolve(r); };
        });
    },
    async saveEntry(k, c) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['entries'], 'readwrite');
            const s = tx.objectStore('entries');
            if (!c) s.delete(k); else s.put({ date: k, content: c });
            tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e);
        });
    },
    async bulkSaveEntries(dataObj) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['entries'], 'readwrite');
            const s = tx.objectStore('entries');
            Object.keys(dataObj).forEach(k => s.put({ date: k, content: dataObj[k] }));
            tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e);
        });
    },
    async addSticker(blob) {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['stickers'], 'readwrite');
            tx.objectStore('stickers').add({ image: blob, created: Date.now() });
            tx.oncomplete = () => resolve();
        });
    },
    async getAllStickers() {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['stickers'], 'readonly');
            const req = tx.objectStore('stickers').getAll();
            req.onsuccess = () => resolve(req.result || []);
        });
    },
    async deleteSticker(id) {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['stickers'], 'readwrite');
            tx.objectStore('stickers').delete(id);
            tx.oncomplete = () => resolve();
        });
    },
    async saveAsset(id, blob) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['assets'], 'readwrite');
            tx.objectStore('assets').put({ id: id, blob: blob });
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
        });
    },
    async getAsset(id) {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['assets'], 'readonly');
            const req = tx.objectStore('assets').get(id);
            req.onsuccess = () => resolve(req.result ? req.result.blob : null);
            req.onerror = () => resolve(null);
        });
    },
    async deleteAsset(id) {
         return new Promise((resolve) => {
            const tx = this.db.transaction(['assets'], 'readwrite');
            tx.objectStore('assets').delete(id);
            tx.oncomplete = () => resolve();
        });
    }
};

// ==========================================
// 初始化
// ==========================================
let cropperInstance = null;
let notifyInterval = null;
let currentPinInput = ""; 

async function init() {
    registerRealSW(); 

    await AppDB.init();
    state.diaryData = await AppDB.loadAllEntries();

    try {
        state.todoData = JSON.parse(localStorage.getItem('myDiaryTodo_v2') || '[]');
        state.settings = Object.assign(state.settings, JSON.parse(localStorage.getItem('myDiarySettings_v2') || '{}'));
        state.security = Object.assign(state.security, JSON.parse(localStorage.getItem('myDiarySecurity_v2') || '{}'));
        state.bgImage = localStorage.getItem('myDiaryBg_v2') || null;
    } catch (e) { console.error("Settings Load Error", e); }

    const hdBg = await AppDB.getAsset('bgImage');
    if (hdBg) {
        state.bgImage = URL.createObjectURL(hdBg);
    }

    checkLockStatus();
    applySettings();
    initSupabase(); 
    if(state.settings.customFont) loadCustomFont(state.settings.customFont);
    renderCalendar();
    renderTodoList();
    renderStickerDrawer(); 
    
    setInterval(autoSave, 60000); 
    startNotificationCheck();
    
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkNotifications(true); });
    document.getElementById('diary-input').addEventListener('input', () => state.isDirty = true);
    
    initDraggable(document.getElementById('index-tab'), 'left');
    initDraggable(document.getElementById('todo-tab'), 'left');
    initDraggable(document.getElementById('fmt-toggle'), 'any');
    initDraggable(document.getElementById('sticker-btn'), 'any'); 
    
    document.getElementById('export-date-picker').valueAsDate = new Date();
    const now = new Date();
    document.getElementById('gallery-month-picker').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

    checkNotifyState();
    
    const toast = document.getElementById('save-toast');
    let startY = 0;
    toast.addEventListener('touchstart', e => startY = e.touches[0].clientY, {passive: true});
    toast.addEventListener('touchmove', e => { 
        if (startY - e.touches[0].clientY > 10) hideToast(); 
    }, {passive: true});
    
    if(document.getElementById('cloud-url')) {
        document.getElementById('cloud-url').value = state.settings.cloudUrl || '';
        document.getElementById('cloud-key').value = state.settings.cloudKey || '';
        if(state.settings.cloudUrl && state.settings.cloudKey) {
             document.getElementById('cloud-ops').style.display = 'flex';
        }
    }

    document.body.addEventListener('click', (e) => {
        if(!e.target.closest('.todo-item-wrapper')) resetAllSwipes();
        if(!e.target.closest('.sticker-item')) {
            document.querySelectorAll('.sticker-item.selected').forEach(el => el.classList.remove('selected'));
        }
    });

    const todoInp = document.getElementById('new-todo-input');
    if(todoInp) {
        todoInp.setAttribute('autocomplete', 'off');
        todoInp.setAttribute('data-lpignore', 'true'); 
        todoInp.name = 'diary_todo_input_' + Math.random().toString(36).substring(7); 
    }
}

function focusInput(e) {
    if(document.getElementById('diary-input').classList.contains('interaction-locked')) return;
    
    const inp = document.getElementById('diary-input');
    if(inp.contentEditable === "true") {
        if(e.target.id === 'diary-scroll-area' || e.target.id === 'diary-input') {
            inp.focus();
        }
    }
}

// 辅助函数
function openCloudHelp(e) { e.stopPropagation(); document.getElementById('cloud-help').classList.add('active'); }
function closeCloudHelp() { document.getElementById('cloud-help').classList.remove('active'); }
function toggleCloudPanel() { const p = document.getElementById('cloud-panel'); p.classList.toggle('open'); }
function copySQL() {
    const text = document.getElementById('sql-code').innerText;
    navigator.clipboard.writeText(text).then(() => showToast("已复制SQL代码"));
}
function handleGlobalClick(e) {
    const tab = document.getElementById('index-tab');
    if(tab.classList.contains('visible')) {
        if (!e.target.closest('#index-tab') && !e.target.closest('.day')) {
            tab.classList.remove('visible');
        }
    }
}
function clearCache() {
    if(confirm("⚠️ 警告\n\n此操作将重置应用设置（主题、密码、字体等）。\n日记数据应当安全（存在数据库中），但仍建议先备份。\n\n确定要重置吗？")) {
        localStorage.clear();
        alert("缓存已清理，应用将重启。");
        location.reload();
    }
}

/* ============ Supabase 逻辑 ============ */
function initSupabase() {
    if(window.supabase && state.settings.cloudUrl && state.settings.cloudKey) {
        try { supabaseClient = window.supabase.createClient(state.settings.cloudUrl, state.settings.cloudKey); } 
        catch(e) { console.error("Supabase Init Fail", e); }
    }
}

function saveCloudConfig() {
    const url = document.getElementById('cloud-url').value.trim();
    const key = document.getElementById('cloud-key').value.trim();
    state.settings.cloudUrl = url;
    state.settings.cloudKey = key;
    saveSettings();
    initSupabase();
    if(url && key) document.getElementById('cloud-ops').style.display = 'flex';
    showToast("配置已保存");
}

async function testCloudConnection() {
    if(!supabaseClient) return alert("请先保存配置");
    showToast("正在连接...");
    const { data, error } = await supabaseClient.from('diary_backup').select('id').limit(1);
    if (error) {
        if(error.code === 'PGRST204' || error.message.includes('does not exist')) {
            alert("连接成功！\n但云端尚未创建表，请查看教程第二步。");
        } else {
            alert("连接失败: " + error.message);
        }
    } else {
        alert("✅ 连接成功！数据库就绪。");
    }
}

async function backupToCloud() {
    if(!supabaseClient) return;
    if(!confirm("确定要备份到云端吗？\n(云端旧数据将被覆盖)")) return;
    const status = document.getElementById('cloud-status');
    status.innerText = "正在打包上传...";
    try {
        const backupData = { updated_at: new Date().toISOString(), diary_data: state.diaryData, todo_data: state.todoData, settings: state.settings, device_info: navigator.userAgent };
        const { data: exist } = await supabaseClient.from('diary_backup').select('id').eq('id', 1).single();
        let err;
        if(exist) { const { error } = await supabaseClient.from('diary_backup').update(backupData).eq('id', 1); err = error; } 
        else { const { error } = await supabaseClient.from('diary_backup').insert([{ id: 1, ...backupData }]); err = error; }
        if(err) throw err;
        status.innerText = "✅ 备份成功 " + new Date().toLocaleTimeString(); showToast("备份成功");
    } catch(e) { status.innerText = "❌ 失败: " + e.message; alert("备份失败: " + e.message); }
}

async function restoreFromCloud() {
    if(!supabaseClient) return;
    if(!confirm("⚠️ 警告：这将下载云端备份并【覆盖】当前数据！\n确定吗？")) return;
    const status = document.getElementById('cloud-status');
    status.innerText = "正在下载...";
    try {
        const { data, error } = await supabaseClient.from('diary_backup').select('*').eq('id', 1).single();
        if(error) throw error; if(!data) return alert("云端无数据");
        status.innerText = "正在恢复...";
        if(data.diary_data) { state.diaryData = data.diary_data; await AppDB.bulkSaveEntries(state.diaryData); }
        if(data.todo_data) { state.todoData = data.todo_data; saveTodo(); }
        
