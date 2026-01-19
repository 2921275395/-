// ==========================================
// script.js - 修复待办排序 & 恢复通知
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

// ==========================================
// 数据库 (AppDB)
// ==========================================
const AppDB = {
    dbName: 'MyDiaryProDB',
    dbVersion: 1,
    db: null,
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'date' });
                if (!db.objectStoreNames.contains('stickers')) db.createObjectStore('stickers', { keyPath: 'id', autoIncrement: true });
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
    }
};

// ==========================================
// 初始化
// ==========================================
let cropperInstance = null;
let notifyInterval = null;
let currentPinInput = ""; 

async function init() {
    registerRealSW(); // 优先注册 SW

    await AppDB.init();
    state.diaryData = await AppDB.loadAllEntries();

    try {
        state.todoData = JSON.parse(localStorage.getItem('myDiaryTodo_v2') || '[]');
        state.settings = Object.assign(state.settings, JSON.parse(localStorage.getItem('myDiarySettings_v2') || '{}'));
        state.security = Object.assign(state.security, JSON.parse(localStorage.getItem('myDiarySecurity_v2') || '{}'));
        state.bgImage = localStorage.getItem('myDiaryBg_v2') || null;
    } catch (e) { console.error("Settings Load Error", e); }

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
}

function focusInput(e) {
    if(e.target.id === 'diary-scroll-area' || e.target.id === 'diary-input') {
        document.getElementById('diary-input').focus();
    }
}

// 辅助函数 (UI相关)
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
        status.innerText = "✅ 恢复完成"; showToast("恢复成功");
        setTimeout(() => { renderCalendar(); renderTodoList(); applySettings(); closeSettings(); }, 500);
    } catch(e) { status.innerText = "❌ 恢复失败"; alert("恢复失败: " + e.message); }
}

/* ============ 核心功能 ============ */
function toggleStickerSetting() { state.settings.enableSticker = !state.settings.enableSticker; saveSettings(); applySettings(); }
function openStickerDrawer() { renderStickerDrawer(); document.getElementById('sticker-drawer').classList.add('open'); toggleUI(false); }
function closeStickerDrawer() { document.getElementById('sticker-drawer').classList.remove('open'); isEditingDrawer = false; toggleUI(true); renderStickerDrawer(); }
function toggleEditStickerDrawer() { isEditingDrawer = !isEditingDrawer; renderStickerDrawer(); }
async function renderStickerDrawer() { const list = document.getElementById('sticker-list'); const uploadBtn = list.querySelector('.sticker-add-btn'); list.innerHTML = ''; list.appendChild(uploadBtn); const stickers = await AppDB.getAllStickers(); stickers.forEach(s => { const div = document.createElement('div'); div.className = 'sticker-thumb'; const url = URL.createObjectURL(s.image); let inner = `<img src="${url}">`; if(isEditingDrawer) inner += `<div class="del-mark" onclick="deleteStickerFromLib(${s.id}, event)">删除</div>`; div.innerHTML = inner; if(!isEditingDrawer) div.onclick = () => addStickerToPage(s.image); list.appendChild(div); }); }
async function importStickers(input) { if(!input.files.length) return; for(let file of input.files) { const compressed = await compressImage(file, 1024, 0.8); const blob = await (await fetch(compressed)).blob(); await AppDB.addSticker(blob); } renderStickerDrawer(); input.value = ''; }
function deleteStickerFromLib(id, e) { e.stopPropagation(); if(confirm("删除此贴纸？")) AppDB.deleteSticker(id).then(renderStickerDrawer); }

async function addStickerToPage(blob) { 
    closeStickerDrawer(); 
    const reader = new FileReader(); 
    reader.onload = (e) => { 
        const base64 = e.target.result; 
        const wrapper = document.createElement('div'); 
        wrapper.className = 'sticker-item selected'; 
        wrapper.contentEditable = "false"; 
        // 确保贴纸在上方
        wrapper.style.zIndex = '10'; 
        wrapper.style.left = '50px'; 
        wrapper.style.top = '100px'; 
        wrapper.style.width = '150px'; 
        wrapper.innerHTML = `<img src="${base64}" draggable="false"><div class="sticker-ctrl ctrl-del" onmousedown="removeSticker(event)" ontouchstart="removeSticker(event)">✕</div><div class="sticker-ctrl ctrl-resize" data-action="resize">↘</div>`; 
        document.getElementById('diary-scroll-area').appendChild(wrapper); 
        attachStickerEvents(wrapper); 
        state.isDirty = true; 
    }; 
    reader.readAsDataURL(blob); 
}

function activateStickerElement(el) {
    document.querySelectorAll('.sticker-item.selected').forEach(i => i.classList.remove('selected')); 
    el.classList.add('selected');
}

function attachStickerEvents(el) { 
    let mode = ''; 
    let startX, startY, startLeft, startTop; 
    let centerX, centerY, startWidth, startHeight, startAngle = 0, initialAngle = 0; 
    let startDist = 0, startScaleWidth = 0, startRotation = 0; 

    const handleStart = (e) => {
        activateStickerElement(el);
        const touches = e.touches; 
        const target = e.target; 

        if (touches && touches.length === 2) { 
            mode = 'gesture'; 
            e.preventDefault(); 
            e.stopPropagation();
            const rect = el.getBoundingClientRect(); 
            startScaleWidth = rect.width; 
            const style = window.getComputedStyle(el); 
            const matrix = new WebKitCSSMatrix(style.transform); 
            startRotation = Math.round(Math.atan2(matrix.b, matrix.a) * (180/Math.PI)); 
            startDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); 
            startAngle = Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX); 
        } else if (!touches || touches.length === 1) { 
            const clientX = touches ? touches[0].clientX : e.clientX;
            const clientY = touches ? touches[0].clientY : e.clientY;

            if (target.dataset.action === 'resize') { 
                mode = 'resize'; 
                e.preventDefault(); 
                e.stopPropagation(); 
                const rect = el.getBoundingClientRect(); 
                centerX = rect.left + rect.width / 2; 
                centerY = rect.top + rect.height / 2; 
                startWidth = rect.width; 
                startHeight = rect.height; 
                startAngle = Math.atan2(clientY - centerY, clientX - centerX); 
                const style = window.getComputedStyle(el); 
                const matrix = new WebKitCSSMatrix(style.transform); 
                initialAngle = Math.round(Math.atan2(matrix.b, matrix.a) * (180/Math.PI)); 
            } else if(!target.classList.contains('sticker-ctrl')) { 
                mode = 'move'; 
                startX = clientX; 
                startY = clientY; 
                startLeft = el.offsetLeft; 
                startTop = el.offsetTop; 
            } 
        } 
    };

    el.addEventListener('mousedown', handleStart); 
    el.addEventListener('touchstart', handleStart, {passive: false}); 

    const handleMove = (e) => { 
        if(!el.classList.contains('selected')) return; 
        const touches = e.touches; 
        
        if (mode === 'gesture' && touches && touches.length === 2) { 
            e.preventDefault(); 
            const dist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY); 
            el.style.width = (startScaleWidth * (dist / startDist)) + 'px'; 
            const angle = Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX); 
            el.style.transform = `rotate(${startRotation + (angle - startAngle) * (180 / Math.PI)}deg)`; 
        } else if (mode === 'move' && (!touches || touches.length === 1)) { 
            e.preventDefault(); 
            const clientX = touches ? touches[0].clientX : e.clientX;
            const clientY = touches ? touches[0].clientY : e.clientY;
            el.style.left = (startLeft + (clientX - startX)) + 'px'; 
            el.style.top = (startTop + (clientY - startY)) + 'px'; 
        } else if (mode === 'resize' && (!touches || touches.length === 1)) { 
            e.preventDefault(); 
            const clientX = touches ? touches[0].clientX : e.clientX;
            const clientY = touches ? touches[0].clientY : e.clientY;
            const currentAngle = Math.atan2(clientY - centerY, clientX - centerX); 
            const dist = Math.hypot(clientX - centerX, clientY - centerY); 
            el.style.width = (startWidth * (dist / (Math.hypot(startWidth, startHeight) / 2))) + 'px'; 
            el.style.transform = `rotate(${initialAngle + (currentAngle - startAngle) * (180 / Math.PI)}deg)`; 
        } 
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('touchmove', handleMove, {passive: false});

    const handleEnd = () => { if(mode) state.isDirty = true; mode = ''; };
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchend', handleEnd);
}

window.removeSticker = function(e) { 
    e.stopPropagation(); 
    e.preventDefault(); 
    e.target.closest('.sticker-item')?.remove(); 
    state.isDirty = true; 
};

function compressImage(file, maxWidth, quality) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = (e) => { const img = new Image(); img.onload = () => { const canvas = document.createElement('canvas'); let w = img.width, h = img.height; if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; } canvas.width = w; canvas.height = h; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, w, h); resolve(canvas.toDataURL(file.type, quality)); }; img.src = e.target.result; }; reader.readAsDataURL(file); }); }
function performSearch(query) { const container = document.getElementById('search-results'); container.innerHTML = ''; if(!query.trim()) return; const results = []; const tempDiv = document.createElement('div'); Object.keys(state.diaryData).sort().reverse().forEach(dateKey => { tempDiv.innerHTML = state.diaryData[dateKey]; if(tempDiv.innerText.toLowerCase().includes(query.toLowerCase())) results.push({ date: dateKey, text: tempDiv.innerText }); }); if(!results.length) { container.innerHTML = '<div class="no-results">无结果</div>'; return; } results.forEach(item => { const el = document.createElement('div'); el.className = 'search-item'; const idx = item.text.toLowerCase().indexOf(query.toLowerCase()); const snippet = item.text.substring(Math.max(0, idx-10), Math.min(item.text.length, idx+query.length+20)); el.innerHTML = `<div class="search-date">${item.date}</div><div class="search-snippet">...${snippet.replace(new RegExp(`(${query})`,'gi'), '<span class="highlight-text">$1</span>')}...</div>`; el.onclick = () => { document.getElementById('search-input').value = ''; container.innerHTML = ''; closeSettings(); selectDate(new Date(item.date)); setTimeout(openDiary, 300); }; container.appendChild(el); }); }
function checkLockStatus() { if (state.security.enabled) { document.getElementById('lock-screen').classList.add('active'); updatePinDots(); if (state.security.biometrics && state.security.credentialId) setTimeout(tryBiometric, 500); } else { document.getElementById('lock-screen').classList.remove('active'); } }
function enterPin(num) { if (currentPinInput.length < 4) { currentPinInput += num; updatePinDots(); if (currentPinInput.length === 4) setTimeout(verifyPin, 100); } }
function deletePin() { currentPinInput = currentPinInput.slice(0, -1); updatePinDots(); }
function updatePinDots() { const dots = document.querySelectorAll('.pin-dot'); dots.forEach((dot, index) => { if (index < currentPinInput.length) dot.classList.add('filled'); else dot.classList.remove('filled'); }); }
function verifyPin() { if (currentPinInput === state.security.pin) { document.getElementById('lock-screen').classList.remove('active'); currentPinInput=""; updatePinDots(); showToast("解锁成功"); } else { if(navigator.vibrate) navigator.vibrate([100]); showToast("密码错误"); currentPinInput=""; updatePinDots(); } }
async function tryBiometric() { if (!state.security.credentialId) return; try { await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), allowCredentials: [{ id: Uint8Array.from(atob(state.security.credentialId), c=>c.charCodeAt(0)), type: 'public-key' }], userVerification: "required" } }); document.getElementById('lock-screen').classList.remove('active'); showToast("解锁成功"); } catch (e) {} }
async function registerBiometric() { if (!window.PublicKeyCredential) { alert("不支持"); return false; } try { const cred = await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32), rp: { name: "我的日记本", id: location.hostname }, user: { id: Uint8Array.from("ID", c=>c.charCodeAt(0)), name: "user", displayName: "User" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }], authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" } } }); state.security.credentialId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId))); return true; } catch (e) { alert("注册失败"); return false; } }
function togglePinLock() { if(state.security.enabled) { if(prompt("输入PIN关闭")==state.security.pin) { state.security.enabled=false; state.security.biometrics=false; saveSecurity(); applySettings(); } } else { const p=prompt("设置4位PIN"); if(p&&p.length==4) { state.security.enabled=true; state.security.pin=p; saveSecurity(); applySettings(); } } }
async function toggleBiometrics() { if(!state.security.enabled) return alert("先开启PIN"); if(!state.security.biometrics) { if(await registerBiometric()) { state.security.biometrics=true; saveSecurity(); applySettings(); } } else { state.security.biometrics=false; saveSecurity(); applySettings(); } }
function saveSecurity() { localStorage.setItem('myDiarySecurity_v2', JSON.stringify(state.security)); }
function toggleUI(show) { document.querySelectorAll('.side-tab').forEach(tab => { if(show) { if(tab.id!=='todo-tab' || state.settings.showTodo) tab.classList.remove('hidden-ui'); } else tab.classList.add('hidden-ui'); }); document.getElementById('sticker-btn').style.display = (show && state.settings.enableSticker) ? 'flex' : 'none'; }
function updateTodoTabVisibility() { document.getElementById('todo-tab').style.display = state.settings.showTodo ? 'flex' : 'none'; if(state.settings.showTodo) document.getElementById('todo-tab').classList.remove('hidden-ui'); }
function openTodo() { document.getElementById('todo-view').classList.remove('hidden-right'); toggleUI(false); }
function closeTodo() { document.getElementById('todo-view').classList.add('hidden-right'); toggleUI(true); }
function toggleTodoSetting() { state.settings.showTodo = !state.settings.showTodo; saveSettings(); applySettings(); }

// 注册 Service Worker
function registerRealSW() { 
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW Registered', reg))
            .catch(err => console.error('SW Error', err));
    }
}

function checkNotifyState() { if("Notification" in window && Notification.permission !== "granted") document.getElementById('perm-btn').style.display = 'block'; else document.getElementById('perm-btn').style.display = 'none'; }
function requestNotifyPermission() { Notification.requestPermission().then(p => { if(p==="granted") { document.getElementById('perm-btn').style.display='none'; showToast("通知已开启"); } }); }

// 测试通知
function testNotification() { 
    if(Notification.permission==="granted") {
        try {
            if('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification("测试通知", {body:"功能正常 (SW)"});
                });
            } else {
                new Notification("测试通知", {body:"功能正常 (本地)"}); 
            }
        } catch(e) {
            alert("发送失败: " + e.message);
        }
    } else {
        alert("请先点击上方开启通知权限"); 
    }
}

function addTodo() { const t=document.getElementById('new-todo-input').value.trim(); if(!t) return; state.todoData.unshift({id:Date.now(), text:t, done:false, date:'', time:'', notified:false}); document.getElementById('new-todo-input').value=''; saveTodo(); renderTodoList(); }
function deleteTodo(id) { state.todoData = state.todoData.filter(t=>t.id!==id); saveTodo(); renderTodoList(); }
function toggleTodo(id) { const t=state.todoData.find(i=>i.id===id); if(t) { t.done=!t.done; saveTodo(); renderTodoList(); } }
function updateTodoData(id, k, v) { const t=state.todoData.find(i=>i.id===id); if(t) { t[k]=v; if(k==='time'||k==='date') t.notified=false; saveTodo(); renderTodoList(); } }
function saveTodo() { localStorage.setItem('myDiaryTodo_v2', JSON.stringify(state.todoData)); }

// === 修复后的渲染排序逻辑 ===
function renderTodoList() { 
    const list=document.getElementById('todo-list'); 
    list.innerHTML=''; 
    
    // 排序逻辑：
    // 1. 已完成的在最后 (done=true)
    // 2. 未设置日期的在最前 (!date)
    // 3. 有日期的按时间先后 (date asc)
    // 4. 同日期按时间 (time asc)
    state.todoData.sort((a,b) => {
        // 1. 完成状态差异
        if (a.done !== b.done) return a.done ? 1 : -1;
        
        // 如果都完成了，按ID倒序（新的已完成在前）
        if (a.done) return b.id - a.id;

        // 2. 处理未设置日期 (置顶)
        const noDateA = !a.date;
        const noDateB = !b.date;
        if (noDateA && !noDateB) return -1; // A无日期 -> 靠前
        if (!noDateA && noDateB) return 1;  // B无日期 -> 靠前
        if (noDateA && noDateB) return b.id - a.id; // 都无日期 -> 按创建时间倒序

        // 3. 都有日期 -> 按日期排序
        if (a.date !== b.date) return a.date.localeCompare(b.date);

        // 4. 日期相同 -> 按时间排序
        const timeA = a.time || '00:00';
        const timeB = b.time || '00:00';
        return timeA.localeCompare(timeB);
    });

    state.todoData.forEach(item => { 
        const d = document.createElement('div'); 
        d.className='todo-item-wrapper'; 
        d.innerHTML=`<div class="todo-delete-bg" onclick="deleteTodo(${item.id})">删除</div><div class="todo-item-content ${item.done?'done':''}"><div class="todo-checkbox ${item.done?'checked':''}" onclick="toggleTodo(${item.id});event.stopPropagation()"></div><div class="todo-content-wrapper"><div class="todo-text">${item.text}</div><div class="todo-datetime"><input type="date" class="todo-picker" value="${item.date||''}" onchange="updateTodoData(${item.id},'date',this.value)"><input type="time" class="todo-picker" value="${item.time||''}" onchange="updateTodoData(${item.id},'time',this.value)"></div></div></div>`; 
        attachSwipeEvents(d.querySelector('.todo-item-content')); 
        list.appendChild(d); 
    }); 
}

let currentOpenSwipe = null;
function attachSwipeEvents(el) { let sX; el.addEventListener('touchstart',e=>{if(currentOpenSwipe&&currentOpenSwipe!==el){currentOpenSwipe.style.transform='translateX(0)';currentOpenSwipe=null}sX=e.touches[0].clientX;el.style.transition='none'},{passive:true}); el.addEventListener('touchmove',e=>{let d=e.touches[0].clientX-sX; if(d>0)d=0; if(d<-80)d=-80; el.style.transform=`translateX(${d}px)`},{passive:true}); el.addEventListener('touchend',e=>{el.style.transition='transform 0.2s'; if(e.changedTouches[0].clientX-sX<-40){el.style.transform='translateX(-80px)';currentOpenSwipe=el}else{el.style.transform='translateX(0)'}});}
function resetAllSwipes() { if(currentOpenSwipe) { currentOpenSwipe.style.transform='translateX(0)'; currentOpenSwipe=null; } }

// 通知的轮询检查
function startNotificationCheck() { 
    if(notifyInterval) clearInterval(notifyInterval); 
    notifyInterval = setInterval(()=>{ 
        if(Notification.permission!=="granted") return; 
        const now = new Date(); 
        const m = now.getHours()*60 + now.getMinutes(); 
        const d = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; 
        
        state.todoData.forEach(t => { 
            if(!t.done && t.date===d && t.time && !t.notified) { 
                const [th,tm] = t.time.split(':').map(Number); 
                // 允许1分钟内的误差
                if(Math.abs(m - (th*60 + tm)) <= 1) { 
                    try {
                        if('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                            navigator.serviceWorker.ready.then(reg => reg.showNotification("日记本提醒", {body: t.text}));
                        } else {
                            new Notification("日记本提醒", {body: t.text}); 
                        }
                    } catch(e) { console.error("Notify Error", e); }
                    t.notified = true; 
                    saveTodo(); 
                } 
            } 
        }); 
    }, 5000); 
}

function openMonthGallery() { const v=document.getElementById('gallery-month-picker').value; if(!v) return alert("请选月份"); document.getElementById('month-gallery').classList.remove('hidden-right'); document.getElementById('settings-view').classList.add('hidden-right'); const c=document.getElementById('gallery-content'); c.innerHTML=''; const [y,m]=v.split('-'); const days=new Date(y,m,0).getDate(); let has=false; for(let d=1; d<=days; d++) { const k=`${y}-${m}-${String(d).padStart(2,'0')}`; if(state.diaryData[k]) { has=true; createGalleryCard(c, state.diaryData[k], `${parseInt(m)}/${d}`, k); } } if(!has) c.innerHTML='<div style="opacity:0.5;text-align:center;padding:20px;width:100%">暂无日记</div>'; }
function createGalleryCard(container, content, dateLabel, dateKey) { const w = document.createElement('div'); w.className = `gallery-card ${state.bgImage?'has-bg':''}`; const thumbScaler = document.createElement('div'); thumbScaler.className = 'thumb-scaler'; if(state.bgImage) thumbScaler.style.backgroundImage = `url(${state.bgImage})`; const dateDiv = document.createElement('div'); dateDiv.className = 'thumb-date'; dateDiv.innerText = dateLabel; const textDiv = document.createElement('div'); textDiv.className = 'thumb-text'; textDiv.innerHTML = content; textDiv.querySelectorAll('.sticker-item').forEach(s => { s.style.opacity = '0.2'; s.style.pointerEvents = 'none'; s.style.zIndex = '0'; }); thumbScaler.appendChild(dateDiv); thumbScaler.appendChild(textDiv); w.appendChild(thumbScaler); w.onclick = () => { closeMonthGallery(); selectDate(new Date(dateKey)); setTimeout(openDiary,300); }; container.appendChild(w); }
function closeMonthGallery() { document.getElementById('month-gallery').classList.add('hidden-right'); toggleUI(true); }
function initDraggable(el, type) { let isDragging=false,sX,sY,iL,iT; const W=window.innerWidth,H=window.innerHeight; el.addEventListener('touchstart',e=>{isDragging=false;el.classList.remove('snap-transition');sX=e.touches[0].clientX;sY=e.touches[0].clientY;const r=el.getBoundingClientRect();iL=r.left;iT=r.top},{passive:false}); el.addEventListener('touchmove',e=>{const dX=e.touches[0].clientX-sX,dY=e.touches[0].clientY-sY;if(Math.abs(dX)>5||Math.abs(dY)>5)isDragging=true;if(isDragging){e.preventDefault();let nT=iT+dY,nL=iL+dX;if(nT<0)nT=0;if(nT>H-el.offsetHeight)nT=H-el.offsetHeight;if(type==='left')el.style.top=nT+'px';else{if(nL<0)nL=0;if(nL>W-el.offsetWidth)nL=W-el.offsetWidth;el.style.left=nL+'px';el.style.top=nT+'px';}}},{passive:false}); el.addEventListener('touchend',()=>{if(isDragging){el.classList.add('snap-transition');if(type==='any'){const r=el.getBoundingClientRect();if(r.left+r.width/2<W/2){el.style.left='10px';updateFormatBarPos('right')}else{el.style.left=(W-el.offsetWidth-10)+'px';updateFormatBarPos('left')}}}}); }
function updateFormatBarPos(dir) { const b=document.getElementById('fmt-bar'),t=document.getElementById('fmt-toggle'); if(dir==='right'){b.style.left='60px';b.style.right='auto';b.style.transformOrigin='top left'}else{b.style.right='60px';b.style.left='auto';b.style.transformOrigin='top right'} b.style.top=t.style.top; }
function renderCalendar() { const y=state.currentDate.getFullYear(),m=state.currentDate.getMonth(); document.getElementById('current-month-label').textContent=`${y}年 ${String(m+1).padStart(2,'0')}月`; document.getElementById('month-picker').value=`${y}-${String(m+1).padStart(2,'0')}`; const c=document.getElementById('calendar-days'); c.innerHTML=''; for(let i=0;i<new Date(y,m,1).getDay();i++) c.appendChild(document.createElement('div')); const today=new Date(); for(let i=1;i<=new Date(y,m+1,0).getDate();i++) { const d=document.createElement('div'); d.className='day'; d.textContent=i; const cur=new Date(y,m,i); const k=formatDateKey(cur); if(cur.toDateString()===today.toDateString()) d.classList.add('today'); if(cur.toDateString()===state.selectedDate.toDateString()) d.classList.add('selected'); if(state.diaryData[k]) d.classList.add('has-entry'); d.onclick=(e)=>{e.stopPropagation();selectDate(cur)}; c.appendChild(d); } }
function changeMonth(v) { if(v) { const [y,m]=v.split('-'); state.currentDate=new Date(y,m-1,1); renderCalendar(); } }
function selectDate(d) { state.selectedDate=d; renderCalendar(); document.getElementById('tab-date').textContent=`${d.getMonth()+1}/${d.getDate()}`; document.getElementById('index-tab').classList.add('visible'); }
function openDiary(e) { 
    if(e)e.stopPropagation(); 
    const k=formatDateKey(state.selectedDate); 
    document.getElementById('diary-date-display').textContent=state.selectedDate.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'}); 
    
    const div = document.getElementById('diary-input'); 
    const scrollArea = document.getElementById('diary-scroll-area');
    
    scrollArea.querySelectorAll('.sticker-item').forEach(el => el.remove());
    
    const content = state.diaryData[k] || ''; 
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = content;
    
    const stickers = tempDiv.querySelectorAll('.sticker-item');
    stickers.forEach(s => {
        scrollArea.appendChild(s);
        attachStickerEvents(s);
    });
    
    div.innerHTML = tempDiv.innerHTML; 
    
    document.getElementById('diary-view').classList.remove('hidden-right'); 
    toggleUI(false); 
    document.getElementById('todo-tab').style.display = 'none'; 
    document.getElementById('index-tab').style.display = 'none'; 
    if(state.settings.enableSticker) document.getElementById('sticker-btn').style.display='flex'; 
    state.isDirty=false; 
}
function closeDiary() { document.querySelectorAll('.sticker-item.selected').forEach(el=>el.classList.remove('selected')); saveDiaryManual(false); document.getElementById('diary-view').classList.add('hidden-right'); document.getElementById('fmt-bar').classList.remove('active'); document.getElementById('sticker-btn').style.display='none'; closeStickerDrawer(); toggleUI(true); updateTodoTabVisibility(); document.getElementById('index-tab').style.display = 'flex'; renderCalendar(); }
function changeDay(o) { saveDiaryManual(false); state.selectedDate.setDate(state.selectedDate.getDate()+o); const p=document.getElementById('paper-layer'); const a=o>0?'anim-slide-left':'anim-slide-right'; p.classList.add(a); setTimeout(()=>{openDiary();p.classList.remove(a);p.style.opacity='0';requestAnimationFrame(()=>p.style.opacity='1')},350); }
function toggleFormatToolbar(e) { e.stopPropagation(); const t=document.getElementById('fmt-toggle'); if(t.getBoundingClientRect().left<window.innerWidth/2) updateFormatBarPos('right'); else updateFormatBarPos('left'); document.getElementById('fmt-bar').classList.toggle('active'); }
function execCmd(c,v=null) { document.execCommand(c,false,v); document.getElementById('diary-input').focus(); }
async function saveDiaryManual(toast=true) { 
    const div = document.getElementById('diary-input'); 
    const scrollArea = document.getElementById('diary-scroll-area');
    scrollArea.querySelectorAll('.selected').forEach(e=>e.classList.remove('selected')); 
    const k = formatDateKey(state.selectedDate); 
    const textHtml = div.innerHTML;
    let stickersHtml = '';
    scrollArea.querySelectorAll('.sticker-item').forEach(s => { stickersHtml += s.outerHTML; });
    const combinedHtml = textHtml + stickersHtml;
    if(!state.isDirty && div.innerText.trim()==="" && stickersHtml==="") return; 
    if(div.innerText.trim()==="" && stickersHtml==="") delete state.diaryData[k]; 
    else state.diaryData[k] = combinedHtml; 
    state.isDirty=false; 
    try { await AppDB.saveEntry(k, state.diaryData[k] || null); if(toast) showToast(); } catch(e) { alert("保存失败: " + e.message); } 
}
function autoSave() { if(state.isDirty) saveDiaryManual(true); }
function showToast(m) { const t=document.getElementById('save-toast'); t.innerText=m||"☁️ 已自动保存"; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
function hideToast() { document.getElementById('save-toast').classList.remove('show'); }
function applyFont() { const u=document.getElementById('font-url-input').value.trim(); if(u) { state.settings.customFont=u; loadCustomFont(u); saveSettings(); alert("加载中..."); } }
function resetFont() { state.settings.customFont=""; document.getElementById('font-url-input').value=""; document.documentElement.style.removeProperty('--font-main'); saveSettings(); alert("已还原"); }
function loadCustomFont(u) { const f=new FontFace('MyCustomFont', `url(${u})`); f.load().then(lf=>{document.fonts.add(lf);document.documentElement.style.setProperty('--font-main', '"MyCustomFont", "Nunito", sans-serif')}); }
function exportDiaryImage() { const d=document.getElementById('export-date-picker').value; if(!d) return alert("选日期"); const k=d; const c=state.diaryData[k]; if(!c) return alert("空日记"); showToast("正在生成高清图片..."); const con=document.getElementById('screenshot-container'); con.innerHTML=''; const p=document.createElement('div'); p.className=`paper-container ${state.settings.paper}`; if(state.bgImage){p.style.backgroundImage=`url(${state.bgImage})`;p.classList.add('has-custom-bg')} p.style.height='auto'; p.style.minHeight='800px'; p.style.position='relative'; p.style.borderRadius='0'; p.innerHTML=`<div class="paper-header" style="background:none"><span class="date-display">${d}</span></div><div class="paper-content" style="overflow:visible">${c}</div>`; con.appendChild(p); html2canvas(p,{scale:4, useCORS:true, backgroundColor: state.settings.theme==='theme-beige'?'#fffbf0':null}).then(cvs=>{ const a=document.createElement('a'); a.download=`diary_${k}.png`; a.href=cvs.toDataURL(); a.click(); con.innerHTML=''; showToast("已保存"); }); }
function startCrop(i) { const f=i.files[0]; if(f) { const r=new FileReader(); r.onload=e=>{ document.getElementById('cropper-modal').style.display='flex'; document.getElementById('cropper-img').src=e.target.result; if(cropperInstance)cropperInstance.destroy(); cropperInstance=new Cropper(document.getElementById('cropper-img'),{viewMode:2,dragMode:'move',autoCropArea:1}); }; r.readAsDataURL(f); i.value=''; } }
function cancelCrop() { document.getElementById('cropper-modal').style.display='none'; if(cropperInstance)cropperInstance.destroy(); }
function finishCrop() { if(cropperInstance) { state.bgImage=cropperInstance.getCroppedCanvas({ maxWidth:2560, maxHeight:2560, fillColor:'#fff' }).toDataURL('image/jpeg', 0.9); localStorage.setItem('myDiaryBg_v2',state.bgImage); applyBgImage(); cancelCrop(); showToast("高清背景已设置"); } }
function applyBgImage() { const p=document.getElementById('paper-layer'); if(state.bgImage){p.style.backgroundImage=`url(${state.bgImage})`;p.classList.add('has-custom-bg')}else{p.style.backgroundImage='';p.classList.remove('has-custom-bg')} }
function clearBgImage() { state.bgImage=null; localStorage.removeItem('myDiaryBg_v2'); applyBgImage(); showToast("已还原"); }
function openSettings() { document.getElementById('settings-view').classList.remove('hidden-right'); toggleUI(false); document.getElementById('font-url-input').value=state.settings.customFont||''; }
function closeSettings() { document.getElementById('settings-view').classList.add('hidden-right'); toggleUI(true); saveSettings(); }
function saveSettings() { localStorage.setItem('myDiarySettings_v2', JSON.stringify(state.settings)); }
function toggleDarkMode() { state.settings.darkMode=!state.settings.darkMode; applySettings(); }
function setTheme(t) { state.settings.theme=t; applySettings(); }
function setPaper(p) { state.settings.paper=p; applySettings(); }
function applySettings() { document.body.className=`${state.settings.theme} ${state.settings.paper}`; if(state.settings.darkMode)document.body.classList.add('dark-mode');else document.body.classList.remove('dark-mode'); document.getElementById('btn-dark').textContent=state.settings.darkMode?"ON":"OFF"; document.getElementById('btn-todo-toggle').textContent=state.settings.showTodo?"ON":"OFF"; document.getElementById('btn-sticker-toggle').textContent=state.settings.enableSticker?"ON":"OFF"; document.getElementById('btn-pin-toggle').textContent=state.security.enabled?"ON":"OFF"; document.getElementById('btn-bio-toggle').textContent=state.security.biometrics?"ON":"OFF"; document.getElementById('row-bio').style.display=state.security.enabled?'flex':'none'; applyBgImage(); updateTodoTabVisibility(); }
function formatDateKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function exportData() { const b=new Blob([JSON.stringify(state.diaryData)],{type:"application/json"}); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=`backup_${formatDateKey(new Date())}.json`; a.click(); }
function importData(i) { const f=i.files[0]; if(f) { const r=new FileReader(); r.onload=e=>{ try{state.diaryData=JSON.parse(e.target.result);localStorage.setItem('myDiaryData_v2',JSON.stringify(state.diaryData));renderCalendar();alert("导入成功");}catch(x){alert("格式错误");} }; r.readAsText(f); } }

init();
