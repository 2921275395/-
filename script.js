// 安全初始化状态
let state = {
    currentDate: new Date(),
    selectedDate: new Date(),
    diaryData: {},
    todoData: [],
    settings: { theme: "theme-beige", paper: "paper-lines", darkMode: false, customFont: "", showTodo: true, enableSticker: false },
    security: { enabled: false, pin: "", biometrics: false, credentialId: null },
    bgImage: null,
    isDirty: false
};

// 尝试安全读取数据，防止 JSON 错误导致白屏
try {
    state.diaryData = JSON.parse(localStorage.getItem('myDiaryData_v2') || '{}');
    state.todoData = JSON.parse(localStorage.getItem('myDiaryTodo_v2') || '[]');
    state.settings = Object.assign(state.settings, JSON.parse(localStorage.getItem('myDiarySettings_v2') || '{}'));
    state.security = Object.assign(state.security, JSON.parse(localStorage.getItem('myDiarySecurity_v2') || '{}'));
    state.bgImage = localStorage.getItem('myDiaryBg_v2') || null;
} catch (e) {
    console.error("Data Load Error", e);
    alert("读取数据出错，已重置为安全模式，请尽快导出备份。");
}

// IndexedDB 管理器 (贴纸库)
const StickerDB = {
    dbName: 'DiaryStickerDB',
    dbVersion: 1,
    db: null,
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('stickers')) {
                    db.createObjectStore('stickers', { keyPath: 'id', autoIncrement: true });
                }
            };
            request.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            request.onerror = (e) => reject(e);
        });
    },
    addSticker(blob) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['stickers'], 'readwrite');
            const store = transaction.objectStore('stickers');
            const request = store.add({ image: blob, created: Date.now() });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject();
        });
    },
    getAllStickers() {
        return new Promise((resolve) => {
            const transaction = this.db.transaction(['stickers'], 'readonly');
            const store = transaction.objectStore('stickers');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
        });
    },
    deleteSticker(id) {
        return new Promise((resolve) => {
            const transaction = this.db.transaction(['stickers'], 'readwrite');
            const store = transaction.objectStore('stickers');
            store.delete(id);
            transaction.oncomplete = () => resolve();
        });
    }
};

let cropperInstance = null;
let notifyInterval = null;
let currentPinInput = ""; 
let isEditingDrawer = false;

function init() {
    checkLockStatus();
    applySettings();
    if(state.settings.customFont) loadCustomFont(state.settings.customFont);
    renderCalendar();
    renderTodoList();
    StickerDB.init().then(() => renderStickerDrawer());
    
    setInterval(autoSave, 60000);
    registerRealSW();
    startNotificationCheck();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkNotifications(true); });
    document.getElementById('diary-input').addEventListener('input', () => state.isDirty = true);
    const toast = document.getElementById('save-toast');
    let startY = 0;
    toast.addEventListener('touchstart', e => startY = e.touches[0].clientY);
    toast.addEventListener('touchmove', e => { if (startY - e.touches[0].clientY > 10) hideToast(); });
    
    initDraggable(document.getElementById('index-tab'), 'left');
    initDraggable(document.getElementById('todo-tab'), 'left');
    initDraggable(document.getElementById('fmt-toggle'), 'any');
    initDraggable(document.getElementById('sticker-btn'), 'any'); 
    
    document.getElementById('export-date-picker').valueAsDate = new Date();
    const now = new Date();
    document.getElementById('gallery-month-picker').value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

    checkNotifyState();
    
    document.body.addEventListener('click', (e) => {
        if(!e.target.closest('.todo-item-wrapper')) resetAllSwipes();
        if(!e.target.closest('.sticker-item')) {
            document.querySelectorAll('.sticker-item.selected').forEach(el => el.classList.remove('selected'));
        }
    });
}

/* ============ 贴纸功能逻辑 ============ */
function toggleStickerSetting() {
    state.settings.enableSticker = !state.settings.enableSticker;
    saveSettings();
    applySettings();
}

function openStickerDrawer() {
    renderStickerDrawer();
    document.getElementById('sticker-drawer').classList.add('open');
    toggleUI(false);
}

function closeStickerDrawer() {
    document.getElementById('sticker-drawer').classList.remove('open');
    isEditingDrawer = false;
    toggleUI(true);
    renderStickerDrawer(); 
}

function toggleEditStickerDrawer() {
    isEditingDrawer = !isEditingDrawer;
    renderStickerDrawer();
}

async function renderStickerDrawer() {
    const list = document.getElementById('sticker-list');
    const uploadBtn = list.querySelector('.sticker-add-btn');
    list.innerHTML = '';
    list.appendChild(uploadBtn);

    const stickers = await StickerDB.getAllStickers();
    stickers.forEach(s => {
        const div = document.createElement('div');
        div.className = 'sticker-thumb';
        const url = URL.createObjectURL(s.image);
        let inner = `<img src="${url}">`;
        if(isEditingDrawer) inner += `<div class="del-mark" onclick="deleteStickerFromLib(${s.id}, event)">删除</div>`;
        div.innerHTML = inner;
        if(!isEditingDrawer) div.onclick = () => addStickerToPage(s.image);
        list.appendChild(div);
    });
}

async function importStickers(input) {
    if(!input.files.length) return;
    for(let file of input.files) {
        // 高清化：压缩宽度从300提升至1500
        const compressed = await compressImage(file, 1500, 0.85); 
        const blob = await (await fetch(compressed)).blob();
        await StickerDB.addSticker(blob);
    }
    renderStickerDrawer();
    input.value = '';
}

function deleteStickerFromLib(id, e) {
    e.stopPropagation();
    if(confirm("确定从库中删除此贴纸？")) StickerDB.deleteSticker(id).then(renderStickerDrawer);
}

async function addStickerToPage(blob) {
    closeStickerDrawer();
    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result;
        const wrapper = document.createElement('div');
        wrapper.className = 'sticker-item selected';
        wrapper.contentEditable = "false"; 
        wrapper.style.left = '50px';
        wrapper.style.top = '100px';
        wrapper.style.width = '150px'; 
        
        wrapper.innerHTML = `
            <img src="${base64}" draggable="false">
            <div class="sticker-ctrl ctrl-del" onmousedown="removeSticker(event)" ontouchstart="removeSticker(event)">✕</div>
            <div class="sticker-ctrl ctrl-layer" onmousedown="toggleLayer(event)" ontouchstart="toggleLayer(event)">L</div>
            <div class="sticker-ctrl ctrl-resize" data-action="resize">↘</div>
        `;
        
        document.getElementById('diary-input').appendChild(wrapper);
        attachStickerEvents(wrapper);
        state.isDirty = true;
    };
    reader.readAsDataURL(blob);
}

// 贴纸交互：单指移动，双指缩放/旋转
function attachStickerEvents(el) {
    let mode = ''; // 'move', 'resize', 'gesture'
    let startX, startY, startLeft, startTop;
    let centerX, centerY, startWidth, startHeight, startAngle = 0, initialAngle = 0;
    let startDist = 0, startScaleWidth = 0, startRotation = 0;

    el.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.sticker-item.selected').forEach(i => i.classList.remove('selected'));
        el.classList.add('selected');
    });

    el.addEventListener('touchstart', (e) => {
        const touches = e.touches;
        const target = e.target;
        
        if (touches.length === 2) {
            mode = 'gesture';
            e.preventDefault(); e.stopPropagation();
            const rect = el.getBoundingClientRect();
            startScaleWidth = rect.width;
            const style = window.getComputedStyle(el);
            const matrix = new WebKitCSSMatrix(style.transform);
            startRotation = Math.round(Math.atan2(matrix.b, matrix.a) * (180/Math.PI));
            startDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
            startAngle = Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
        } 
        else if (touches.length === 1) {
            if (target.dataset.action === 'resize') {
                mode = 'resize';
                e.preventDefault(); e.stopPropagation();
                const rect = el.getBoundingClientRect();
                centerX = rect.left + rect.width / 2;
                centerY = rect.top + rect.height / 2;
                startWidth = rect.width;
                startHeight = rect.height;
                startAngle = Math.atan2(touches[0].clientY - centerY, touches[0].clientX - centerX);
                const style = window.getComputedStyle(el);
                const matrix = new WebKitCSSMatrix(style.transform);
                initialAngle = Math.round(Math.atan2(matrix.b, matrix.a) * (180/Math.PI));
            } else if(!target.classList.contains('sticker-ctrl')) {
                mode = 'move';
                startX = touches[0].clientX;
                startY = touches[0].clientY;
                startLeft = el.offsetLeft;
                startTop = el.offsetTop;
            }
        }
    }, {passive: false});

    document.addEventListener('touchmove', (e) => {
        if(!el.classList.contains('selected')) return;
        const touches = e.touches;

        if (mode === 'gesture' && touches.length === 2) {
            e.preventDefault();
            const dist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
            const scaleFactor = dist / startDist;
            el.style.width = (startScaleWidth * scaleFactor) + 'px';
            const angle = Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
            const rotationDiff = (angle - startAngle) * (180 / Math.PI);
            el.style.transform = `rotate(${startRotation + rotationDiff}deg)`;

        } else if (mode === 'move' && touches.length === 1) {
            e.preventDefault();
            const dx = touches[0].clientX - startX;
            const dy = touches[0].clientY - startY;
            el.style.left = (startLeft + dx) + 'px';
            el.style.top = (startTop + dy) + 'px';

        } else if (mode === 'resize' && touches.length === 1) {
            e.preventDefault();
            const touch = touches[0];
            const currentAngle = Math.atan2(touch.clientY - centerY, touch.clientX - centerX);
            const rotation = initialAngle + (currentAngle - startAngle) * (180 / Math.PI);
            const dist = Math.hypot(touch.clientX - centerX, touch.clientY - centerY);
            const scale = dist / (Math.hypot(startWidth, startHeight) / 2);
            el.style.width = (startWidth * scale) + 'px';
            el.style.transform = `rotate(${rotation}deg)`;
        }
    }, {passive: false});

    document.addEventListener('touchend', () => { if(mode) state.isDirty = true; mode = ''; });
}

window.removeSticker = function(e) {
    e.stopPropagation(); e.preventDefault();
    const el = e.target.closest('.sticker-item');
    if(el) el.remove();
    state.isDirty = true;
};

window.toggleLayer = function(e) {
    e.stopPropagation(); e.preventDefault();
    const el = e.target.closest('.sticker-item');
    const current = window.getComputedStyle(el).zIndex;
    // 在文字上方(2) 和 文字下方(-1) 之间切换
    if (current === '-1') {
        el.style.zIndex = '2';
        showToast("图层：文字上方");
    } else {
        el.style.zIndex = '-1';
        showToast("图层：文字下方");
    }
    state.isDirty = true;
};

function compressImage(file, maxWidth, quality) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL(file.type, quality));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

/* ============ 搜索 ============ */
function performSearch(query) {
    const container = document.getElementById('search-results');
    container.innerHTML = '';
    if(!query.trim()) return;
    const results = [];
    const tempDiv = document.createElement('div');
    Object.keys(state.diaryData).sort().reverse().forEach(dateKey => {
        const htmlContent = state.diaryData[dateKey];
        tempDiv.innerHTML = htmlContent;
        const textContent = tempDiv.innerText;
        if(textContent.toLowerCase().includes(query.toLowerCase())) {
            results.push({ date: dateKey, text: textContent });
        }
    });
    if(results.length === 0) { container.innerHTML = '<div class="no-results">没有找到相关日记</div>'; return; }
    results.forEach(item => {
        const dateObj = new Date(item.date);
        const dateStr = dateObj.toLocaleDateString('zh-CN', {year:'numeric', month:'long', day:'numeric', weekday:'short'});
        const index = item.text.toLowerCase().indexOf(query.toLowerCase());
        let start = Math.max(0, index - 10);
        let end = Math.min(item.text.length, index + query.length + 20);
        let snippet = item.text.substring(start, end);
        if(start > 0) snippet = '...' + snippet;
        if(end < item.text.length) snippet = snippet + '...';
        const regex = new RegExp(`(${query})`, 'gi');
        const highlightSnippet = snippet.replace(regex, '<span class="highlight-text">$1</span>');
        const el = document.createElement('div');
        el.className = 'search-item';
        el.innerHTML = `<div class="search-date">${dateStr}</div><div class="search-snippet">${highlightSnippet}</div>`;
        el.onclick = () => {
            document.getElementById('search-input').value = '';
            container.innerHTML = '';
            closeSettings();
            selectDate(dateObj);
            setTimeout(openDiary, 300);
        };
        container.appendChild(el);
    });
}

/* ============ 锁屏 ============ */
function bufferToBase64(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))); }
function base64ToBuffer(base64) { return Uint8Array.from(atob(base64), c => c.charCodeAt(0)); }
function checkLockStatus() {
    if (state.security.enabled) {
        document.getElementById('lock-screen').classList.add('active');
        updatePinDots();
        if (state.security.biometrics && state.security.credentialId) setTimeout(tryBiometric, 500);
    } else {
        document.getElementById('lock-screen').classList.remove('active');
    }
}
function enterPin(num) { if (currentPinInput.length < 4) { currentPinInput += num; updatePinDots(); if (currentPinInput.length === 4) setTimeout(verifyPin, 100); } }
function deletePin() { currentPinInput = currentPinInput.slice(0, -1); updatePinDots(); }
function updatePinDots() { const dots = document.querySelectorAll('.pin-dot'); dots.forEach((dot, index) => { if (index < currentPinInput.length) dot.classList.add('filled'); else dot.classList.remove('filled'); }); }
function verifyPin() { if (currentPinInput === state.security.pin) unlockSuccess(); else { if(navigator.vibrate) navigator.vibrate([100, 50, 100]); showToast("密码错误"); currentPinInput = ""; updatePinDots(); } }
function unlockSuccess() { document.getElementById('lock-screen').classList.remove('active'); currentPinInput = ""; updatePinDots(); showToast("解锁成功"); }
async function registerBiometric() {
    if (!window.PublicKeyCredential) { alert("环境不支持生物识别"); return false; }
    const publicKey = { challenge: new Uint8Array(32), rp: { name: "我的日记本", id: window.location.hostname }, user: { id: Uint8Array.from("USER_ID", c => c.charCodeAt(0)), name: "user@diary.local", displayName: "日记本主人" }, pubKeyCredParams: [{ alg: -7, type: "public-key" }, { alg: -257, type: "public-key" }], authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" }, timeout: 60000 };
    try { showToast("请验证以注册..."); const credential = await navigator.credentials.create({ publicKey }); state.security.credentialId = bufferToBase64(credential.rawId); return true; } catch (e) { console.error(e); alert("注册失败: " + e.message); return false; }
}
async function tryBiometric() { if (!state.security.credentialId) { if(state.security.enabled) showToast("未绑定指纹"); return; } try { const publicKey = { challenge: new Uint8Array(32), allowCredentials: [{ id: base64ToBuffer(state.security.credentialId), type: 'public-key', transports: ['internal'] }], userVerification: "required", timeout: 60000 }; await navigator.credentials.get({ publicKey }); unlockSuccess(); } catch (e) { console.log("Biometric failed", e); } }
function togglePinLock() { if (state.security.enabled) { const pin = prompt("输入当前PIN码关闭："); if (pin === state.security.pin) { state.security.enabled = false; state.security.biometrics = false; state.security.credentialId = null; saveSecurity(); applySettings(); showToast("已关闭"); } else if (pin !== null) alert("密码错误"); } else { const newPin = prompt("设置4位PIN码："); if (newPin && newPin.length === 4 && !isNaN(newPin)) { state.security.enabled = true; state.security.pin = newPin; saveSecurity(); applySettings(); showToast("已开启"); } else if (newPin !== null) alert("请输入4位数字"); } }
async function toggleBiometrics() { if (!state.security.enabled) { alert("请先开启PIN码"); return; } if (!state.security.biometrics) { const success = await registerBiometric(); if (success) { state.security.biometrics = true; saveSecurity(); applySettings(); showToast("生物识别已开启"); } } else { state.security.biometrics = false; state.security.credentialId = null; saveSecurity(); applySettings(); showToast("生物识别已关闭"); } }
function saveSecurity() { localStorage.setItem('myDiarySecurity_v2', JSON.stringify(state.security)); }

/* ============ UI & Notify ============ */
function toggleUI(show) { const tabs = document.querySelectorAll('.side-tab'); tabs.forEach(tab => { if(show) { if(tab.id === 'todo-tab') { if(state.settings.showTodo) tab.classList.remove('hidden-ui'); } else { tab.classList.remove('hidden-ui'); } } else { tab.classList.add('hidden-ui'); } }); const stickerBtn = document.getElementById('sticker-btn'); if(show && state.settings.enableSticker) { stickerBtn.style.display = 'flex'; } else { stickerBtn.style.display = 'none'; } }
function updateTodoTabVisibility() { const tab = document.getElementById('todo-tab'); if(state.settings.showTodo) { tab.style.display = 'flex'; const isViewOpen = !document.getElementById('settings-view').classList.contains('hidden-right') || !document.getElementById('diary-view').classList.contains('hidden-right'); if(!isViewOpen) tab.classList.remove('hidden-ui'); } else { tab.style.display = 'none'; } }
function openTodo() { document.getElementById('todo-view').classList.remove('hidden-right'); toggleUI(false); }
function closeTodo() { document.getElementById('todo-view').classList.add('hidden-right'); toggleUI(true); }
function toggleTodoSetting() { state.settings.showTodo = !state.settings.showTodo; saveSettings(); applySettings(); }
function registerRealSW() { if (!('serviceWorker' in navigator)) { return; } navigator.serviceWorker.register('sw.js').catch(err => { if (/Android/i.test(navigator.userAgent)) { document.getElementById('android-sw-missing').style.display = 'block'; } }); }
function checkNotifyState() { if (!("Notification" in window)) { document.getElementById('perm-btn').innerText = "❌ 不支持通知"; document.getElementById('perm-btn').style.display = 'block'; } else if (Notification.permission !== "granted") { document.getElementById('perm-btn').style.display = 'block'; } else { document.getElementById('perm-btn').style.display = 'none'; } }
async function sendSafeNotification(title, body) { if ('serviceWorker' in navigator) { try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) { reg.showNotification(title, { body: body, icon: 'https://via.placeholder.com/128', vibrate: [200, 100, 200], requireInteraction: true }); return; } } catch (e) { console.error(e); } } if (/Android/i.test(navigator.userAgent)) { showToast("⚠️ 安卓未连接 sw.js"); return; } try { new Notification(title, { body: body }); } catch (e) {} }
function requestNotifyPermission() { Notification.requestPermission().then(permission => { if (permission === "granted") { document.getElementById('perm-btn').style.display = 'none'; showToast("通知已开启 ✅"); sendSafeNotification("日记本提醒", "权限获取成功！"); } else { alert("权限被拒绝。"); } }); }
function testNotification() { if (Notification.permission === "granted") { showToast("已请求发送..."); sendSafeNotification("测试通知", "如果您看到这条消息，说明功能正常！📱"); } else { alert("请先点击开启通知权限"); } }
function addTodo() { const input = document.getElementById('new-todo-input'); const text = input.value.trim(); if(!text) return; state.todoData.unshift({ id: Date.now(), text: text, done: false, date: '', time: '', notified: false }); input.value = ''; saveTodo(); renderTodoList(); }
function toggleTodo(id) { const item = state.todoData.find(t => t.id === id); if(item) { item.done = !item.done; saveTodo(); renderTodoList(); } }
function deleteTodo(id) { state.todoData = state.todoData.filter(t => t.id !== id); saveTodo(); renderTodoList(); }
function updateTodoData(id, field, val) { const item = state.todoData.find(t => t.id === id); if(item) { item[field] = val; if(field === 'time' || field === 'date') item.notified = false; saveTodo(); renderTodoList(); } } 
function saveTodo() { localStorage.setItem('myDiaryTodo_v2', JSON.stringify(state.todoData)); }
function renderTodoList() { const list = document.getElementById('todo-list'); list.innerHTML = ''; const sortedData = [...state.todoData].sort((a, b) => { if (a.done !== b.done) return a.done ? 1 : -1; const aHasTime = a.date && a.time; const bHasTime = b.date && b.time; if (!aHasTime && bHasTime) return -1; if (aHasTime && !bHasTime) return 1; if (!aHasTime && !bHasTime) return b.id - a.id; return new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`); }); sortedData.forEach(item => { const wrapper = document.createElement('div'); wrapper.className = 'todo-item-wrapper'; wrapper.innerHTML = `<div class="todo-delete-bg" onclick="deleteTodo(${item.id})">删除</div><div class="todo-item-content ${item.done ? 'done' : ''}" id="todo-content-${item.id}"><div class="todo-checkbox ${item.done ? 'checked' : ''}" onclick="toggleTodo(${item.id}); event.stopPropagation();"></div><div class="todo-content-wrapper"><div class="todo-text">${item.text}</div><div class="todo-datetime"><input type="date" class="todo-picker" value="${item.date || ''}" onchange="updateTodoData(${item.id}, 'date', this.value)"><input type="time" class="todo-picker" value="${item.time || ''}" onchange="updateTodoData(${item.id}, 'time', this.value)"></div></div></div>`; const contentEl = wrapper.querySelector('.todo-item-content'); attachSwipeEvents(contentEl); list.appendChild(wrapper); }); }
let currentOpenSwipe = null;
function attachSwipeEvents(el) { let startX, currentX; let isDragging = false; el.addEventListener('touchstart', (e) => { if(currentOpenSwipe && currentOpenSwipe !== el) { currentOpenSwipe.style.transform = 'translateX(0)'; currentOpenSwipe = null; } startX = e.touches[0].clientX; el.style.transition = 'none'; }, {passive: true}); el.addEventListener('touchmove', (e) => { currentX = e.touches[0].clientX; let deltaX = currentX - startX; if (deltaX > 0) deltaX = 0; if (deltaX < -80) deltaX = -80; if (deltaX < -10) isDragging = true; el.style.transform = `translateX(${deltaX}px)`; }, {passive: true}); el.addEventListener('touchend', (e) => { el.style.transition = 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)'; const deltaX = currentX - startX; if (deltaX < -40) { el.style.transform = 'translateX(-80px)'; currentOpenSwipe = el; } else { el.style.transform = 'translateX(0)'; if(currentOpenSwipe === el) currentOpenSwipe = null; } isDragging = false; }); }
function resetAllSwipes() { const openItems = document.querySelectorAll('.todo-item-content[style*="translateX(-80px)"]'); openItems.forEach(el => el.style.transform = 'translateX(0)'); currentOpenSwipe = null; }
function startNotificationCheck() { if(notifyInterval) clearInterval(notifyInterval); notifyInterval = setInterval(() => checkNotifications(false), 5000); }
function checkNotifications(isCatchUp) { if (!("Notification" in window) || Notification.permission !== "granted") return; const now = new Date(); const currentStrDate = formatDateKey(now); const currentTotalMinutes = now.getHours() * 60 + now.getMinutes(); state.todoData.forEach(item => { if(!item.done && item.date && item.time && !item.notified) { if (item.date === currentStrDate) { const [h, m] = item.time.split(':').map(Number); const targetTotalMinutes = h * 60 + m; const isTime = Math.abs(currentTotalMinutes - targetTotalMinutes) <= 1; const isMissed = isCatchUp && (currentTotalMinutes > targetTotalMinutes); if (isTime || isMissed) { let bodyText = item.text; if (isMissed) bodyText = "[错过提醒] " + bodyText; sendSafeNotification("日记本提醒", bodyText); item.notified = true; saveTodo(); } } } }); }

/* ============ 月度回顾 ============ */
function openMonthGallery() { const picker = document.getElementById('gallery-month-picker'); if(!picker.value) { alert("请选择月份"); return; } document.getElementById('month-gallery').classList.remove('hidden-right'); document.getElementById('settings-view').classList.add('hidden-right'); const gallery = document.getElementById('gallery-content'); gallery.innerHTML = ''; const [y, m] = picker.value.split('-'); const daysInMonth = new Date(y, m, 0).getDate(); let hasData = false; for(let d=1; d<=daysInMonth; d++) { const dateStr = `${y}-${m}-${String(d).padStart(2,'0')}`; if(state.diaryData[dateStr]) { hasData = true; const content = state.diaryData[dateStr]; const dateDisplay = `${parseInt(m)}/${d}`; createGalleryCard(gallery, content, dateDisplay, false, dateStr); if(content.length > 500 || (content.match(/\n/g) || []).length > 10) { createGalleryCard(gallery, content, '', true, dateStr); } } } if(!hasData) { gallery.innerHTML = '<div style="width:100%; text-align:center; padding:50px; opacity:0.5">该月没有日记</div>'; } }
function createGalleryCard(container, content, dateLabel, isPage2, dateKey) { const wrapper = document.createElement('div'); wrapper.className = `gallery-card ${state.bgImage ? 'has-bg' : ''}`; const scaler = document.createElement('div'); scaler.className = `thumb-scaler ${isPage2 ? 'thumb-split-2' : ''}`; if(state.bgImage) scaler.style.backgroundImage = `url(${state.bgImage})`; let html = ''; if(!isPage2) { html += `<div class="thumb-date">${dateLabel}</div>`; } const tempDiv = document.createElement('div'); tempDiv.innerHTML = content; tempDiv.querySelectorAll('.sticker-item').forEach(el => el.remove()); html += `<div class="thumb-text">${tempDiv.innerHTML}</div>`; scaler.innerHTML = html; wrapper.appendChild(scaler); wrapper.onclick = () => { const parts = dateKey.split('-'); const targetDate = new Date(parts[0], parts[1]-1, parts[2]); closeMonthGallery(); selectDate(targetDate); setTimeout(openDiary, 300); }; container.appendChild(wrapper); }
function closeMonthGallery() { document.getElementById('month-gallery').classList.add('hidden-right'); toggleUI(true); }

function initDraggable(el, type) { let isDragging = false; let startX, startY, initialLeft, initialTop; const screenW = window.innerWidth; const screenH = window.innerHeight; el.addEventListener('touchstart', (e) => { isDragging = false; el.classList.remove('snap-transition'); const touch = e.touches[0]; startX = touch.clientX; startY = touch.clientY; const rect = el.getBoundingClientRect(); initialLeft = rect.left; initialTop = rect.top; }, {passive: false}); el.addEventListener('touchmove', (e) => { const touch = e.touches[0]; const deltaX = touch.clientX - startX; const deltaY = touch.clientY - startY; if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) isDragging = true; if (isDragging) { e.preventDefault(); let newTop = initialTop + deltaY; let newLeft = initialLeft + deltaX; if (newTop < 0) newTop = 0; if (newTop > screenH - el.offsetHeight) newTop = screenH - el.offsetHeight; if (type === 'left') { el.style.top = newTop + 'px'; } else { if (newLeft < 0) newLeft = 0; if (newLeft > screenW - el.offsetWidth) newLeft = screenW - el.offsetWidth; el.style.left = newLeft + 'px'; el.style.top = newTop + 'px'; document.getElementById('fmt-bar').classList.remove('active'); } } }, {passive: false}); el.addEventListener('touchend', (e) => { if (!isDragging) return; el.classList.add('snap-transition'); if (type === 'any') { const rect = el.getBoundingClientRect(); const centerX = rect.left + rect.width / 2; if (centerX < screenW / 2) { el.style.left = '10px'; updateFormatBarPos('right'); } else { el.style.left = (screenW - el.offsetWidth - 10) + 'px'; updateFormatBarPos('left'); } } }); }
function updateFormatBarPos(direction) { const bar = document.getElementById('fmt-bar'); const toggle = document.getElementById('fmt-toggle'); if (direction === 'right') { bar.style.left = '60px'; bar.style.right = 'auto'; bar.style.transformOrigin = 'top left'; } else { bar.style.right = '60px'; bar.style.left = 'auto'; bar.style.transformOrigin = 'top right'; } bar.style.top = toggle.style.top; }
function handleGlobalClick(e) { const tab = document.getElementById('index-tab'); if (tab.classList.contains('visible') && !e.target.closest('#index-tab') && !e.target.closest('.day')) { tab.classList.remove('visible'); tab.style.transform = ''; } const fmtBar = document.getElementById('fmt-bar'); if(fmtBar.classList.contains('active') && !e.target.closest('.format-toolbar') && !e.target.closest('.format-toolbar-toggle')) { fmtBar.classList.remove('active'); } }
function renderCalendar() { const year = state.currentDate.getFullYear(); const month = state.currentDate.getMonth(); document.getElementById('current-month-label').textContent = `${year}年 ${String(month + 1).padStart(2, '0')}月`; document.getElementById('month-picker').value = `${year}-${String(month + 1).padStart(2, '0')}`; const firstDay = new Date(year, month, 1); const lastDay = new Date(year, month + 1, 0); const daysContainer = document.getElementById('calendar-days'); daysContainer.innerHTML = ''; for (let i = 0; i < firstDay.getDay(); i++) daysContainer.appendChild(document.createElement('div')); const today = new Date(); for (let i = 1; i <= lastDay.getDate(); i++) { const dayEl = document.createElement('div'); dayEl.className = 'day'; dayEl.textContent = i; const thisDate = new Date(year, month, i); const dateKey = formatDateKey(thisDate); if (isSameDay(thisDate, today)) dayEl.classList.add('today'); if (isSameDay(thisDate, state.selectedDate)) dayEl.classList.add('selected'); if (state.diaryData[dateKey]) dayEl.classList.add('has-entry'); dayEl.onclick = (e) => { e.stopPropagation(); selectDate(thisDate); }; daysContainer.appendChild(dayEl); } }
function changeMonth(val) { if(!val) return; const [y, m] = val.split('-'); state.currentDate = new Date(parseInt(y), parseInt(m) - 1, 1); renderCalendar(); }
function selectDate(date) { state.selectedDate = date; renderCalendar(); document.getElementById('tab-date').textContent = `${date.getMonth() + 1}/${date.getDate()}`; document.getElementById('index-tab').classList.add('visible'); }
function openDiary(e) { if(e) e.stopPropagation(); const dateKey = formatDateKey(state.selectedDate); document.getElementById('diary-date-display').textContent = state.selectedDate.toLocaleDateString('zh-CN', {month:'long',day:'numeric',weekday:'long'}); const content = state.diaryData[dateKey] || ''; const inputDiv = document.getElementById('diary-input'); if (content.indexOf('<') === -1 && content.indexOf('\n') !== -1) inputDiv.innerText = content; else inputDiv.innerHTML = content; document.querySelectorAll('.sticker-item').forEach(el => attachStickerEvents(el)); document.getElementById('diary-view').classList.remove('hidden-right'); toggleUI(false); if(state.settings.enableSticker) document.getElementById('sticker-btn').style.display = 'flex'; state.isDirty = false; }
function closeDiary() { document.querySelectorAll('.sticker-item.selected').forEach(el => el.classList.remove('selected')); saveDiaryManual(false); document.getElementById('diary-view').classList.add('hidden-right'); document.getElementById('fmt-bar').classList.remove('active'); document.getElementById('sticker-btn').style.display = 'none'; closeStickerDrawer(); toggleUI(true); renderCalendar(); }
function changeDay(offset) { saveDiaryManual(false); const newDate = new Date(state.selectedDate); newDate.setDate(newDate.getDate() + offset); state.selectedDate = newDate; const paper = document.getElementById('paper-layer'); const anim = offset > 0 ? 'anim-slide-left' : 'anim-slide-right'; paper.classList.add(anim); setTimeout(() => { openDiary(); paper.classList.remove(anim); paper.style.opacity = '0'; requestAnimationFrame(() => paper.style.opacity = '1'); }, 350); }
function toggleFormatToolbar(e) { e.stopPropagation(); const toggle = document.getElementById('fmt-toggle'); const rect = toggle.getBoundingClientRect(); if (rect.left < window.innerWidth/2) updateFormatBarPos('right'); else updateFormatBarPos('left'); document.getElementById('fmt-bar').classList.toggle('active'); }
function execCmd(command, value = null) { document.execCommand(command, false, value); document.getElementById('diary-input').focus(); }
function saveDiaryManual(showToastFlag = true) { const inputDiv = document.getElementById('diary-input'); const selected = inputDiv.querySelectorAll('.sticker-item.selected'); selected.forEach(el => el.classList.remove('selected')); if (!state.isDirty && inputDiv.innerText.trim() === "" && !inputDiv.querySelector('img')) return; const dateKey = formatDateKey(state.selectedDate); const content = inputDiv.innerHTML; if (inputDiv.innerText.trim() === "" && !content.includes('<img')) delete state.diaryData[dateKey]; else state.diaryData[dateKey] = content; localStorage.setItem('myDiaryData_v2', JSON.stringify(state.diaryData)); state.isDirty = false; if (showToastFlag) showToast(); }
function autoSave() { if (state.isDirty) saveDiaryManual(true); }
function showToast(msg) { const t=document.getElementById('save-toast'); t.innerText = msg || "☁️ 已自动保存"; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }
function hideToast() { document.getElementById('save-toast').classList.remove('show'); }
function applyFont() { const url = document.getElementById('font-url-input').value.trim(); if(!url) return; state.settings.customFont = url; loadCustomFont(url); saveSettings(); alert("正在加载..."); }
function resetFont() { state.settings.customFont = ""; document.getElementById('font-url-input').value = ""; document.documentElement.style.removeProperty('--font-main'); saveSettings(); alert("已还原默认字体"); }
function loadCustomFont(url) { if(url.includes('fonts.googleapis.com')) { const link = document.createElement('link'); link.href = url; link.rel = 'stylesheet'; document.head.appendChild(link); return; } const fontName = 'MyCustomFont'; const fontFace = new FontFace(fontName, `url(${url})`); fontFace.load().then(loadedFace => { document.fonts.add(loadedFace); document.documentElement.style.setProperty('--font-main', `"${fontName}", "Nunito", sans-serif`); }).catch(e => { console.error(e); }); }
function exportDiaryImage() { const picker = document.getElementById('export-date-picker'); if(!picker.value) { alert("请选择日期"); return; } const dateStr = picker.value; const parts = dateStr.split('-'); const targetDate = new Date(parts[0], parts[1]-1, parts[2]); const dateKey = formatDateKey(targetDate); const content = state.diaryData[dateKey]; if(!content) { alert("这一天没有日记哦"); return; } showToast("正在生成图片..."); const container = document.getElementById('screenshot-container'); container.innerHTML = ''; const paper = document.createElement('div'); paper.className = `paper-container ${state.settings.paper}`; if(state.bgImage) { paper.style.backgroundImage = `url(${state.bgImage})`; paper.classList.add('has-custom-bg'); } paper.style.height = 'auto'; paper.style.minHeight = '800px'; paper.style.position = 'relative'; paper.style.overflow = 'visible'; paper.style.borderRadius = '0'; const header = document.createElement('div'); header.className = 'paper-header'; header.innerHTML = `<span class="date-display">${targetDate.toLocaleDateString('zh-CN', {month:'long',day:'numeric',weekday:'long'})}</span>`; header.style.background = 'none'; paper.appendChild(header); const body = document.createElement('div'); body.className = 'paper-content'; body.style.overflow = 'visible'; body.innerHTML = content; paper.appendChild(body); container.appendChild(paper); html2canvas(paper, { scale: 2, useCORS: true, backgroundColor: state.settings.theme === 'theme-beige' ? '#fffbf0' : null }).then(canvas => { const link = document.createElement('a'); link.download = `diary_${dateKey}.png`; link.href = canvas.toDataURL(); link.click(); container.innerHTML = ''; showToast("图片已保存！"); }).catch(err => { console.error(err); alert("生成失败，请重试"); container.innerHTML = ''; }); }

function startCrop(input) { const file = input.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { document.getElementById('cropper-modal').style.display = 'flex'; const image = document.getElementById('cropper-img'); image.src = e.target.result; if (cropperInstance) cropperInstance.destroy(); cropperInstance = new Cropper(image, { viewMode: 2, dragMode: 'move', aspectRatio: NaN, autoCropArea: 1 }); }; reader.readAsDataURL(file); input.value = ''; }
function cancelCrop() { document.getElementById('cropper-modal').style.display = 'none'; if(cropperInstance) cropperInstance.destroy(); }
function finishCrop() { if (!cropperInstance) return; const canvas = cropperInstance.getCroppedCanvas({ maxWidth: 1024, maxHeight: 1024 }); const dataUrl = canvas.toDataURL('image/jpeg', 0.8); state.bgImage = dataUrl; try { localStorage.setItem('myDiaryBg_v2', dataUrl); applyBgImage(); cancelCrop(); showToast("背景设置成功"); } catch (e) { alert("图片太大了"); } }
function applyBgImage() { const paper = document.getElementById('paper-layer'); if (state.bgImage) { paper.style.backgroundImage = `url(${state.bgImage})`; paper.classList.add('has-custom-bg'); } else { paper.style.backgroundImage = ''; paper.classList.remove('has-custom-bg'); } }
function clearBgImage() { state.bgImage = null; localStorage.removeItem('myDiaryBg_v2'); applyBgImage(); showToast("背景已还原"); }
function openSettings() { document.getElementById('settings-view').classList.remove('hidden-right'); toggleUI(false); document.getElementById('font-url-input').value = state.settings.customFont || ''; }
function closeSettings() { document.getElementById('settings-view').classList.add('hidden-right'); toggleUI(true); saveSettings(); }
function saveSettings() { localStorage.setItem('myDiarySettings_v2', JSON.stringify(state.settings)); }
function toggleDarkMode() { state.settings.darkMode = !state.settings.darkMode; applySettings(); }
function setTheme(theme) { state.settings.theme = theme; applySettings(); }
function setPaper(paper) { state.settings.paper = paper; applySettings(); }
function applySettings() { document.body.className = `${state.settings.theme} ${state.settings.paper}`; if (state.settings.darkMode) document.body.classList.add('dark-mode'); else document.body.classList.remove('dark-mode'); document.getElementById('btn-dark').textContent = state.settings.darkMode ? "ON" : "OFF"; document.getElementById('btn-todo-toggle').textContent = state.settings.showTodo ? "ON" : "OFF"; document.getElementById('btn-sticker-toggle').textContent = state.settings.enableSticker ? "ON" : "OFF"; document.getElementById('btn-pin-toggle').textContent = state.security.enabled ? "ON" : "OFF"; document.getElementById('btn-bio-toggle').textContent = state.security.biometrics ? "ON" : "OFF"; document.getElementById('row-bio').style.display = state.security.enabled ? 'flex' : 'none'; applyBgImage(); updateTodoTabVisibility(); }
function formatDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }
function isSameDay(d1, d2) { return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate(); }
function exportData() { const blob = new Blob([JSON.stringify(state.diaryData)], {type: "application/json"}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `diary_backup_${formatDateKey(new Date())}.json`; a.click(); }
function importData(input) { const file = input.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { state.diaryData = JSON.parse(e.target.result); localStorage.setItem('myDiaryData_v2', JSON.stringify(state.diaryData)); renderCalendar(); alert("导入成功"); } catch(err) { alert("文件格式错误"); } }; reader.readAsText(file); }

// 启动应用
init();
