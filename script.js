// ============ 1. 数据初始化 ============
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

// 安全读取本地存储
try {
    const sData = localStorage.getItem('myDiaryData_v2');
    const sTodo = localStorage.getItem('myDiaryTodo_v2');
    const sSet = localStorage.getItem('myDiarySettings_v2');
    const sSec = localStorage.getItem('myDiarySecurity_v2');
    const sBg = localStorage.getItem('myDiaryBg_v2');

    if(sData) state.diaryData = JSON.parse(sData);
    if(sTodo) state.todoData = JSON.parse(sTodo);
    if(sSet) state.settings = Object.assign(state.settings, JSON.parse(sSet));
    if(sSec) state.security = Object.assign(state.security, JSON.parse(sSec));
    if(sBg) state.bgImage = sBg;
} catch (e) { console.error("Data error", e); }

// ============ 2. 贴纸数据库 (IndexedDB) ============
const StickerDB = {
    dbName: 'DiaryStickerDB', dbVersion: 1, db: null,
    init() {
        return new Promise((resolve) => {
            try {
                const req = indexedDB.open(this.dbName, this.dbVersion);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains('stickers')) db.createObjectStore('stickers', { keyPath: 'id', autoIncrement: true });
                };
                req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
                req.onerror = () => resolve();
            } catch(e) { resolve(); }
        });
    },
    addSticker(blob) {
        if(!this.db) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const t = this.db.transaction(['stickers'], 'readwrite');
            t.objectStore('stickers').add({ image: blob, created: Date.now() });
            t.oncomplete = () => resolve();
            t.onerror = () => reject();
        });
    },
    getAllStickers() {
        if(!this.db) return Promise.resolve([]);
        return new Promise((resolve) => {
            const t = this.db.transaction(['stickers'], 'readonly');
            const req = t.objectStore('stickers').getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    },
    deleteSticker(id) {
        if(!this.db) return Promise.resolve();
        return new Promise((resolve) => {
            this.db.transaction(['stickers'], 'readwrite').objectStore('stickers').delete(id).onsuccess = () => resolve();
        });
    }
};

let cropperInstance = null;
let notifyInterval = null;
let currentPinInput = ""; 
let isEditingDrawer = false;

// ============ 3. 程序入口 ============
function init() {
    console.log("Starting App...");
    
    // 1. 强制显示主页，防止任何隐藏属性残留
    const home = document.getElementById('home-view');
    if(home) {
        home.classList.remove('hidden-right');
        home.style.visibility = 'visible';
        home.style.display = 'flex';
        home.style.zIndex = '1'; 
    }

    // 2. 应用设置
    applySettings();
    if(state.settings.customFont) loadCustomFont(state.settings.customFont);

    // 3. 渲染页面内容
    renderCalendar();
    renderTodoList();
    StickerDB.init().then(() => renderStickerDrawer());

    // 4. 检查锁屏 (这是关键)
    checkLockStatus();

    // 5. 其他杂项初始化
    setInterval(autoSave, 60000);
    registerRealSW();
    startNotificationCheck();
    
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkNotifications(true); });
    const dInput = document.getElementById('diary-input');
    if(dInput) dInput.addEventListener('input', () => state.isDirty = true);

    initDraggable(document.getElementById('index-tab'), 'left');
    initDraggable(document.getElementById('todo-tab'), 'left');
    initDraggable(document.getElementById('fmt-toggle'), 'any');
    initDraggable(document.getElementById('sticker-btn'), 'any');

    const ePicker = document.getElementById('export-date-picker');
    if(ePicker) ePicker.valueAsDate = new Date();
    const gPicker = document.getElementById('gallery-month-picker');
    if(gPicker) { const now = new Date(); gPicker.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`; }

    checkNotifyState();

    document.body.addEventListener('click', (e) => {
        if(!e.target.closest('.todo-item-wrapper')) resetAllSwipes();
        if(!e.target.closest('.sticker-item')) document.querySelectorAll('.sticker-item.selected').forEach(el => el.classList.remove('selected'));
    });
}

// ============ 4. 核心功能：解锁 ============
function checkLockStatus() {
    const lockScreen = document.getElementById('lock-screen');
    if (!lockScreen) return;
    
    if (state.security.enabled) {
        lockScreen.style.display = 'flex';
        lockScreen.style.opacity = '1';
        lockScreen.style.visibility = 'visible';
        lockScreen.classList.add('active');
        updatePinDots();
        
        // 如果开启了生物识别，尝试自动调用
        if (state.security.biometrics && state.security.credentialId) {
            setTimeout(tryBiometric, 500);
        }
    } else {
        lockScreen.style.display = 'none';
        lockScreen.classList.remove('active');
    }
}

// 核心修复：解锁成功函数
function unlockSuccess() {
    const lockScreen = document.getElementById('lock-screen');
    
    // 1. 立即隐藏锁屏 (不要等待动画，防止JS报错导致卡死)
    if(lockScreen) {
        lockScreen.classList.remove('active');
        lockScreen.style.display = 'none'; // 强制隐藏
        lockScreen.style.visibility = 'hidden';
    }

    // 2. 清空PIN码状态
    currentPinInput = "";
    updatePinDots();
    
    // 3. 强制唤醒主页 (修复白屏的关键)
    const homeView = document.getElementById('home-view');
    if(homeView) {
        homeView.classList.remove('hidden-right');
        homeView.style.display = 'flex';
        homeView.style.visibility = 'visible';
    }
    
    // 4. 重新渲染日历，确保内容存在
    setTimeout(renderCalendar, 50);
    
    showToast("🔓 解锁成功");
}

function verifyPin() {
    if (currentPinInput === state.security.pin) {
        unlockSuccess();
    } else {
        if(navigator.vibrate) navigator.vibrate([100, 50, 100]);
        showToast("密码错误");
        currentPinInput = "";
        updatePinDots();
    }
}

// ============ 5. 其他功能逻辑 ============

// 锁屏数字键盘
function enterPin(num) { 
    if (currentPinInput.length < 4) { 
        currentPinInput += num; 
        updatePinDots(); 
        if (currentPinInput.length === 4) setTimeout(verifyPin, 100); 
    } 
}
function deletePin() { currentPinInput = currentPinInput.slice(0, -1); updatePinDots(); }
function updatePinDots() { 
    const dots = document.querySelectorAll('.pin-dot'); 
    dots.forEach((dot, index) => { 
        if (index < currentPinInput.length) dot.classList.add('filled'); 
        else dot.classList.remove('filled'); 
    }); 
}

// 生物识别
function bufferToBase64(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))); }
function base64ToBuffer(base64) { return Uint8Array.from(atob(base64), c => c.charCodeAt(0)); }

async function registerBiometric() {
    if (!window.PublicKeyCredential) { alert("设备不支持生物识别"); return false; }
    const publicKey = { challenge: new Uint8Array(32), rp: { name: "日记本", id: window.location.hostname }, user: { id: Uint8Array.from("USER", c=>c.charCodeAt(0)), name: "user@local", displayName: "User" }, pubKeyCredParams: [{alg:-7,type:"public-key"},{alg:-257,type:"public-key"}], authenticatorSelection: {authenticatorAttachment:"platform", userVerification:"required"}, timeout: 60000 };
    try { 
        showToast("请验证指纹/面容..."); 
        const credential = await navigator.credentials.create({ publicKey }); 
        state.security.credentialId = bufferToBase64(credential.rawId); 
        return true; 
    } catch (e) { alert("注册失败: " + e.message); return false; }
}

async function tryBiometric() {
    if (!state.security.credentialId) { if(state.security.enabled) showToast("未设置生物识别"); return; }
    try {
        const publicKey = { challenge: new Uint8Array(32), allowCredentials: [{ id: base64ToBuffer(state.security.credentialId), type: 'public-key', transports: ['internal'] }], userVerification: "required", timeout: 60000 };
        await navigator.credentials.get({ publicKey });
        unlockSuccess(); // 验证成功，调用解锁
    } catch (e) { console.log("Biometric skipped", e); }
}

function togglePinLock() {
    if(state.security.enabled) {
        const p = prompt("输入当前PIN码关闭：");
        if(p === state.security.pin) { state.security.enabled = false; state.security.biometrics = false; saveSecurity(); applySettings(); checkLockStatus(); showToast("已关闭保护"); }
        else if(p !== null) alert("密码错误");
    } else {
        const n = prompt("设置4位PIN码：");
        if(n && n.length===4 && !isNaN(n)) { state.security.enabled = true; state.security.pin = n; saveSecurity(); applySettings(); checkLockStatus(); showToast("已开启保护"); }
        else if(n !== null) alert("请输入4位数字");
    }
}
async function toggleBiometrics() {
    if(!state.security.enabled) { alert("请先开启PIN码"); return; }
    if(!state.security.biometrics) {
        if(await registerBiometric()) { state.security.biometrics = true; saveSecurity(); applySettings(); showToast("生物识别已开启"); }
    } else {
        state.security.biometrics = false; state.security.credentialId = null; saveSecurity(); applySettings(); showToast("生物识别已关闭");
    }
}
function saveSecurity() { localStorage.setItem('myDiarySecurity_v2', JSON.stringify(state.security)); }

// 贴纸逻辑
function toggleStickerSetting() { state.settings.enableSticker = !state.settings.enableSticker; saveSettings(); applySettings(); }
function openStickerDrawer() { renderStickerDrawer(); document.getElementById('sticker-drawer').classList.add('open'); toggleUI(false); }
function closeStickerDrawer() { document.getElementById('sticker-drawer').classList.remove('open'); isEditingDrawer = false; toggleUI(true); renderStickerDrawer(); }
function toggleEditStickerDrawer() { isEditingDrawer = !isEditingDrawer; renderStickerDrawer(); }
async function renderStickerDrawer() {
    const list = document.getElementById('sticker-list'); if(!list) return;
    const btn = list.querySelector('.sticker-add-btn'); list.innerHTML = ''; if(btn) list.appendChild(btn);
    (await StickerDB.getAllStickers()).forEach(s => {
        const d = document.createElement('div'); d.className = 'sticker-thumb';
        let h = `<img src="${URL.createObjectURL(s.image)}">`;
        if(isEditingDrawer) h+=`<div class="del-mark" onclick="deleteStickerFromLib(${s.id},event)">删除</div>`;
        d.innerHTML = h; if(!isEditingDrawer) d.onclick=()=>addStickerToPage(s.image);
        list.appendChild(d);
    });
}
async function importStickers(input) {
    if(!input.files.length) return;
    for(let f of input.files) { try { await StickerDB.addSticker(await (await fetch(await compressImage(f,1500,0.85))).blob()); } catch(e){} }
    renderStickerDrawer(); input.value='';
}
function deleteStickerFromLib(id,e) { e.stopPropagation(); if(confirm("删除此贴纸？")) StickerDB.deleteSticker(id).then(renderStickerDrawer); }
function addStickerToPage(blob) {
    closeStickerDrawer();
    const reader = new FileReader();
    reader.onload = (e) => {
        const div = document.createElement('div'); div.className = 'sticker-item selected';
        div.contentEditable="false"; div.style.left='50px'; div.style.top='100px'; div.style.width='150px';
        div.innerHTML=`<img src="${e.target.result}" draggable="false"><div class="sticker-ctrl ctrl-del" onmousedown="removeSticker(event)" ontouchstart="removeSticker(event)">✕</div><div class="sticker-ctrl ctrl-layer" onmousedown="toggleLayer(event)" ontouchstart="toggleLayer(event)">L</div><div class="sticker-ctrl ctrl-resize" data-action="resize">↘</div>`;
        document.getElementById('diary-input').appendChild(div); attachStickerEvents(div); state.isDirty=true;
    }; reader.readAsDataURL(blob);
}
function attachStickerEvents(el) {
    let mode='', startX, startY, startLeft, startTop, startW, startH, startAngle=0, initAngle=0, cx, cy, startDist, startScaleW, startRot;
    el.addEventListener('click', e=>{ e.stopPropagation(); document.querySelectorAll('.sticker-item.selected').forEach(i=>i.classList.remove('selected')); el.classList.add('selected'); });
    el.addEventListener('touchstart', e=>{
        const t=e.touches, target=e.target;
        if(t.length===2) {
            mode='gesture'; e.preventDefault(); e.stopPropagation();
            const rect=el.getBoundingClientRect(); startScaleW=rect.width;
            const mat=new WebKitCSSMatrix(window.getComputedStyle(el).transform);
            startRot=Math.round(Math.atan2(mat.b,mat.a)*(180/Math.PI));
            startDist=Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
            startAngle=Math.atan2(t[1].clientY-t[0].clientY, t[1].clientX-t[0].clientX);
        } else if(t.length===1) {
            if(target.dataset.action==='resize') {
                mode='resize'; e.preventDefault(); e.stopPropagation();
                const rect=el.getBoundingClientRect(); cx=rect.left+rect.width/2; cy=rect.top+rect.height/2;
                startW=rect.width; startH=rect.height;
                startAngle=Math.atan2(t[0].clientY-cy, t[0].clientX-cx);
                const mat=new WebKitCSSMatrix(window.getComputedStyle(el).transform);
                initAngle=Math.round(Math.atan2(mat.b,mat.a)*(180/Math.PI));
            } else if(!target.classList.contains('sticker-ctrl')) {
                mode='move'; startX=t[0].clientX; startY=t[0].clientY; startLeft=el.offsetLeft; startTop=el.offsetTop;
            }
        }
    }, {passive:false});
    document.addEventListener('touchmove', e=>{
        if(!el.classList.contains('selected')) return;
        const t=e.touches;
        if(mode==='gesture' && t.length===2) {
            e.preventDefault();
            const dist=Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
            const ang=Math.atan2(t[1].clientY-t[0].clientY, t[1].clientX-t[0].clientX);
            el.style.width=(startScaleW*(dist/startDist))+'px';
            el.style.transform=`rotate(${startRot+(ang-startAngle)*(180/Math.PI)}deg)`;
        } else if(mode==='move' && t.length===1) {
            e.preventDefault();
            el.style.left=(startLeft+t[0].clientX-startX)+'px'; el.style.top=(startTop+t[0].clientY-startY)+'px';
        } else if(mode==='resize' && t.length===1) {
            e.preventDefault();
            const ang=Math.atan2(t[0].clientY-cy, t[0].clientX-cx);
            const dist=Math.hypot(t[0].clientX-cx, t[0].clientY-cy);
            el.style.width=(startW*(dist/(Math.hypot(startW,startH)/2)))+'px';
            el.style.transform=`rotate(${initAngle+(ang-startAngle)*(180/Math.PI)}deg)`;
        }
    }, {passive:false});
    document.addEventListener('touchend', ()=>{if(mode)state.isDirty=true; mode='';});
}
window.removeSticker=function(e){ e.stopPropagation(); e.preventDefault(); e.target.closest('.sticker-item').remove(); state.isDirty=true; };
window.toggleLayer=function(e){ e.stopPropagation(); e.preventDefault(); const el=e.target.closest('.sticker-item'); el.style.zIndex=(getComputedStyle(el).zIndex==='-1'?'2':'-1'); state.isDirty=true; showToast("图层已切换"); };
function compressImage(file,mw,q){ return new Promise(r=>{ const reader=new FileReader(); reader.onload=e=>{ const img=new Image(); img.onload=()=>{ const c=document.createElement('canvas'); let w=img.width,h=img.height; if(w>mw){h=(h*mw)/w;w=mw;} c.width=w;c.height=h; c.getContext('2d').drawImage(img,0,0,w,h); r(c.toDataURL(file.type,q)); }; img.src=e.target.result; }; reader.readAsDataURL(file); }); }

// 通用UI控制
function toggleUI(show) { 
    document.querySelectorAll('.side-tab').forEach(tab=>{
        if(show) { if(tab.id!=='todo-tab' || state.settings.showTodo) tab.classList.remove('hidden-ui'); }
        else tab.classList.add('hidden-ui');
    });
    const sb = document.getElementById('sticker-btn');
    if(sb) sb.style.display = (show && state.settings.enableSticker) ? 'flex' : 'none';
}
function updateTodoTabVisibility() { 
    const tab=document.getElementById('todo-tab'); if(!tab)return;
    if(state.settings.showTodo) {
        tab.style.display='flex';
        const hidden = !document.getElementById('settings-view').classList.contains('hidden-right') || !document.getElementById('diary-view').classList.contains('hidden-right');
        if(!hidden) tab.classList.remove('hidden-ui');
    } else tab.style.display='none';
}
function openTodo(){ document.getElementById('todo-view').classList.remove('hidden-right'); toggleUI(false); }
function closeTodo(){ document.getElementById('todo-view').classList.add('hidden-right'); toggleUI(true); }
function toggleTodoSetting(){ state.settings.showTodo=!state.settings.showTodo; saveSettings(); applySettings(); }
function registerRealSW(){ if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{if(/Android/i.test(navigator.userAgent)) document.getElementById('android-sw-missing').style.display='block';}); }
function checkNotifyState(){ const b=document.getElementById('perm-btn'); if(b){ if(!("Notification" in window)){b.innerText="❌ 不支持";b.style.display='block';} else if(Notification.permission!=="granted") b.style.display='block'; else b.style.display='none'; } }
async function sendSafeNotification(t,b){ if('serviceWorker' in navigator){ try{const r=await navigator.serviceWorker.getRegistration();if(r){r.showNotification(t,{body:b,icon:'https://via.placeholder.com/128',vibrate:[200]});return;}}catch(e){} } new Notification(t,{body:b}); }
function requestNotifyPermission(){ Notification.requestPermission().then(p=>{if(p==="granted"){checkNotifyState();showToast("通知开启");}else alert("拒绝");}); }
function testNotification(){ if(Notification.permission==="granted"){showToast("发送中...");sendSafeNotification("测试","功能正常");}else alert("请先开启权限"); }

// 待办事项
function addTodo(){ const i=document.getElementById('new-todo-input'); const v=i.value.trim(); if(!v)return; state.todoData.unshift({id:Date.now(),text:v,done:false,date:'',time:'',notified:false}); i.value=''; saveTodo(); renderTodoList(); }
function toggleTodo(id){ const t=state.todoData.find(x=>x.id===id); if(t){t.done=!t.done; saveTodo(); renderTodoList();} }
function deleteTodo(id){ state.todoData=state.todoData.filter(x=>x.id!==id); saveTodo(); renderTodoList(); }
function updateTodoData(id,f,v){ const t=state.todoData.find(x=>x.id===id); if(t){t[f]=v;if(f==='time'||f==='date')t.notified=false; saveTodo(); renderTodoList();} }
function saveTodo(){ localStorage.setItem('myDiaryTodo_v2',JSON.stringify(state.todoData)); }
function renderTodoList(){
    const l=document.getElementById('todo-list'); if(!l)return; l.innerHTML='';
    [...state.todoData].sort((a,b)=>{ if(a.done!==b.done)return a.done?1:-1; return (a.date&&b.date)?new Date(a.date+a.time)-new Date(b.date+b.time):b.id-a.id; })
    .forEach(i=>{
        const w=document.createElement('div'); w.className='todo-item-wrapper';
        w.innerHTML=`<div class="todo-delete-bg" onclick="deleteTodo(${i.id})">删除</div><div class="todo-item-content ${i.done?'done':''}" id="todo-content-${i.id}"><div class="todo-checkbox ${i.done?'checked':''}" onclick="toggleTodo(${i.id});event.stopPropagation()"></div><div class="todo-content-wrapper"><div class="todo-text">${i.text}</div><div class="todo-datetime"><input type="date" class="todo-picker" value="${i.date||''}" onchange="updateTodoData(${i.id},'date',this.value)"><input type="time" class="todo-picker" value="${i.time||''}" onchange="updateTodoData(${i.id},'time',this.value)"></div></div></div>`;
        attachSwipeEvents(w.querySelector('.todo-item-content')); l.appendChild(w);
    });
}
let currentOpenSwipe=null;
function attachSwipeEvents(el){
    let sx,cx,drag=false;
    el.addEventListener('touchstart',e=>{ if(currentOpenSwipe&&currentOpenSwipe!==el){currentOpenSwipe.style.transform='translateX(0)';currentOpenSwipe=null;} sx=e.touches[0].clientX; el.style.transition='none'; },{passive:true});
    el.addEventListener('touchmove',e=>{ cx=e.touches[0].clientX; let d=cx-sx; if(d>0)d=0; if(d<-80)d=-80; if(d<-10)drag=true; el.style.transform=`translateX(${d}px)`; },{passive:true});
    el.addEventListener('touchend',()=>{ el.style.transition='transform 0.2s'; if(cx-sx<-40){el.style.transform='translateX(-80px)';currentOpenSwipe=el;}else{el.style.transform='translateX(0)';if(currentOpenSwipe===el)currentOpenSwipe=null;} drag=false; });
}
function resetAllSwipes(){ if(currentOpenSwipe){currentOpenSwipe.style.transform='translateX(0)';currentOpenSwipe=null;} }
function startNotificationCheck(){ if(notifyInterval)clearInterval(notifyInterval); notifyInterval=setInterval(()=>checkNotifications(false),5000); }
function checkNotifications(catchUp){ 
    if(!("Notification" in window)||Notification.permission!=="granted")return; 
    const now=new Date(), str=formatDateKey(now), curM=now.getHours()*60+now.getMinutes();
    state.todoData.forEach(i=>{
        if(!i.done&&i.date&&i.time&&!i.notified){
            if(i.date===str){
                const [h,m]=i.time.split(':').map(Number), tM=h*60+m;
                if(Math.abs(curM-tM)<=1 || (catchUp && curM>tM)){ sendSafeNotification("提醒", (catchUp?"[错过] ":"")+i.text); i.notified=true; saveTodo(); }
            }
        }
    });
}

// 渲染日历 & 视图切换
function renderCalendar() {
    const y=state.currentDate.getFullYear(), m=state.currentDate.getMonth();
    const lbl=document.getElementById('current-month-label'); if(lbl) lbl.textContent=`${y}年 ${String(m+1).padStart(2,'0')}月`;
    const pkr=document.getElementById('month-picker'); if(pkr) pkr.value=`${y}-${String(m+1).padStart(2,'0')}`;
    const con=document.getElementById('calendar-days'); if(!con) return;
    con.innerHTML='';
    const fd=new Date(y,m,1), ld=new Date(y,m+1,0);
    for(let i=0;i<fd.getDay();i++) con.appendChild(document.createElement('div'));
    const today=new Date();
    for(let i=1;i<=ld.getDate();i++){
        const d=document.createElement('div'); d.className='day'; d.textContent=i;
        const dt=new Date(y,m,i), k=formatDateKey(dt);
        if(isSameDay(dt,today)) d.classList.add('today');
        if(isSameDay(dt,state.selectedDate)) d.classList.add('selected');
        if(state.diaryData[k]) d.classList.add('has-entry');
        d.onclick=(e)=>{e.stopPropagation();selectDate(dt);};
        con.appendChild(d);
    }
}
function changeMonth(v){ if(!v)return; const [y,m]=v.split('-'); state.currentDate=new Date(parseInt(y),parseInt(m)-1,1); renderCalendar(); }
function selectDate(d){ state.selectedDate=d; renderCalendar(); document.getElementById('tab-date').textContent=`${d.getMonth()+1}/${d.getDate()}`; document.getElementById('index-tab').classList.add('visible'); }
function openDiary(e){ if(e)e.stopPropagation(); const k=formatDateKey(state.selectedDate); document.getElementById('diary-date-display').textContent=state.selectedDate.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'}); const div=document.getElementById('diary-input'); div.innerHTML=state.diaryData[k]||''; div.querySelectorAll('.sticker-item').forEach(x=>attachStickerEvents(x)); document.getElementById('diary-view').classList.remove('hidden-right'); toggleUI(false); if(state.settings.enableSticker)document.getElementById('sticker-btn').style.display='flex'; state.isDirty=false; }
function closeDiary(){ document.querySelectorAll('.sticker-item.selected').forEach(x=>x.classList.remove('selected')); saveDiaryManual(false); document.getElementById('diary-view').classList.add('hidden-right'); document.getElementById('fmt-bar').classList.remove('active'); closeStickerDrawer(); toggleUI(true); renderCalendar(); }
function changeDay(off){ saveDiaryManual(false); state.selectedDate.setDate(state.selectedDate.getDate()+off); const p=document.getElementById('paper-layer'); p.classList.add(off>0?'anim-slide-left':'anim-slide-right'); setTimeout(()=>{openDiary(); p.classList.remove('anim-slide-left','anim-slide-right'); p.style.opacity='0'; requestAnimationFrame(()=>p.style.opacity='1');},350); }
function toggleFormatToolbar(e){ e.stopPropagation(); const t=document.getElementById('fmt-toggle'), b=document.getElementById('fmt-bar'); if(t.getBoundingClientRect().left<window.innerWidth/2){b.style.left='60px';b.style.right='auto';b.style.transformOrigin='top left';}else{b.style.right='60px';b.style.left='auto';b.style.transformOrigin='top right';} b.style.top=t.style.top; b.classList.toggle('active'); }
function execCmd(c,v){ document.execCommand(c,false,v); document.getElementById('diary-input').focus(); }
function saveDiaryManual(toast=true){ const d=document.getElementById('diary-input'); d.querySelectorAll('.sticker-item.selected').forEach(x=>x.classList.remove('selected')); if(!state.isDirty&&!d.innerText.trim()&&!d.querySelector('img'))return; const k=formatDateKey(state.selectedDate), c=d.innerHTML; if(!d.innerText.trim()&&!c.includes('<img')) delete state.diaryData[k]; else state.diaryData[k]=c; localStorage.setItem('myDiaryData_v2',JSON.stringify(state.diaryData)); state.isDirty=false; if(toast)showToast(); }
function autoSave(){ if(state.isDirty)saveDiaryManual(true); }
function showToast(m){ const t=document.getElementById('save-toast'); if(t){t.innerText=m||"☁️ 已保存"; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500);} }
function hideToast(){ const t=document.getElementById('save-toast'); if(t)t.classList.remove('show'); }

// 拖拽
function initDraggable(el,type){
    if(!el)return; let drag=false,sx,sy,sl,st; const W=window.innerWidth,H=window.innerHeight;
    el.addEventListener('touchstart',e=>{ drag=false; el.classList.remove('snap-transition'); sx=e.touches[0].clientX; sy=e.touches[0].clientY; const r=el.getBoundingClientRect(); sl=r.left; st=r.top; },{passive:false});
    el.addEventListener('touchmove',e=>{ const tx=e.touches[0].clientX, ty=e.touches[0].clientY; if(Math.abs(tx-sx)>5||Math.abs(ty-sy)>5)drag=true; if(drag){e.preventDefault(); let nt=st+(ty-sy), nl=sl+(tx-sx); if(nt<0)nt=0; if(nt>H-el.offsetHeight)nt=H-el.offsetHeight; if(type==='left') el.style.top=nt+'px'; else{ if(nl<0)nl=0; if(nl>W-el.offsetWidth)nl=W-el.offsetWidth; el.style.left=nl+'px'; el.style.top=nt+'px'; document.getElementById('fmt-bar').classList.remove('active'); } } },{passive:false});
    el.addEventListener('touchend',()=>{ if(!drag)return; el.classList.add('snap-transition'); if(type==='any'){ const cx=el.getBoundingClientRect().left+el.offsetWidth/2; if(cx<W/2)el.style.left='10px'; else el.style.left=(W-el.offsetWidth-10)+'px'; } });
}

// 辅助函数
function applySettings(){ document.body.className=`${state.settings.theme} ${state.settings.paper}`; if(state.settings.darkMode)document.body.classList.add('dark-mode'); else document.body.classList.remove('dark-mode'); document.getElementById('btn-dark').innerText=state.settings.darkMode?"ON":"OFF"; document.getElementById('btn-todo-toggle').innerText=state.settings.showTodo?"ON":"OFF"; document.getElementById('btn-sticker-toggle').innerText=state.settings.enableSticker?"ON":"OFF"; document.getElementById('btn-pin-toggle').innerText=state.security.enabled?"ON":"OFF"; document.getElementById('btn-bio-toggle').innerText=state.security.biometrics?"ON":"OFF"; document.getElementById('row-bio').style.display=state.security.enabled?'flex':'none'; const p=document.getElementById('paper-layer'); if(state.bgImage){p.style.backgroundImage=`url(${state.bgImage})`;p.classList.add('has-custom-bg');}else{p.style.backgroundImage='';p.classList.remove('has-custom-bg');} updateTodoTabVisibility(); }
function formatDateKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function isSameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function startCrop(i){ const f=i.files[0]; if(!f)return; const r=new FileReader(); r.onload=e=>{document.getElementById('cropper-modal').style.display='flex'; const img=document.getElementById('cropper-img'); img.src=e.target.result; if(cropperInstance)cropperInstance.destroy(); cropperInstance=new Cropper(img,{viewMode:2,dragMode:'move',autoCropArea:1});}; r.readAsDataURL(f); i.value=''; }
function cancelCrop(){ document.getElementById('cropper-modal').style.display='none'; if(cropperInstance)cropperInstance.destroy(); }
function finishCrop(){ if(!cropperInstance)return; state.bgImage=cropperInstance.getCroppedCanvas({maxWidth:1024,maxHeight:1024}).toDataURL('image/jpeg',0.8); try{localStorage.setItem('myDiaryBg_v2',state.bgImage);applySettings();cancelCrop();showToast("背景已应用");}catch(e){alert("图片太大");} }
function clearBgImage(){ state.bgImage=null; localStorage.removeItem('myDiaryBg_v2'); applySettings(); showToast("背景已还原"); }
function loadCustomFont(u){ const f=new FontFace('MyCustomFont',`url(${u})`); f.load().then(l=>{document.fonts.add(l);document.documentElement.style.setProperty('--font-main',`"MyCustomFont", "Nunito", sans-serif`);}).catch(()=>{}); }
function openSettings(){ document.getElementById('settings-view').classList.remove('hidden-right'); toggleUI(false); }
function closeSettings(){ document.getElementById('settings-view').classList.add('hidden-right'); toggleUI(true); saveSettings(); }
function saveSettings(){ localStorage.setItem('myDiarySettings_v2',JSON.stringify(state.settings)); }
function toggleDarkMode(){ state.settings.darkMode=!state.settings.darkMode; applySettings(); }
function setTheme(t){ state.settings.theme=t; applySettings(); }
function setPaper(p){ state.settings.paper=p; applySettings(); }
function exportData(){ const b=new Blob([JSON.stringify(state.diaryData)],{type:"application/json"}); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download=`backup_${formatDateKey(new Date())}.json`; a.click(); }
function importData(i){ const f=i.files[0]; if(!f)return; const r=new FileReader(); r.onload=e=>{try{state.diaryData=JSON.parse(e.target.result);localStorage.setItem('myDiaryData_v2',JSON.stringify(state.diaryData));renderCalendar();alert("成功");}catch(x){alert("格式错误");}}; r.readAsText(f); }

function performSearch(q){
    const c=document.getElementById('search-results'); c.innerHTML=''; if(!q.trim())return;
    const res=[]; const t=document.createElement('div');
    Object.keys(state.diaryData).sort().reverse().forEach(k=>{ t.innerHTML=state.diaryData[k]; if(t.innerText.toLowerCase().includes(q.toLowerCase())) res.push({d:k,t:t.innerText}); });
    if(!res.length){c.innerHTML='<div class="no-results">无结果</div>';return;}
    res.forEach(r=>{
        const d=new Date(r.d), idx=r.t.toLowerCase().indexOf(q.toLowerCase()), s=Math.max(0,idx-10), e=Math.min(r.t.length,idx+q.length+20);
        const snip=(s>0?'...':'')+r.t.substring(s,e).replace(new RegExp(`(${q})`,'gi'),'<span class="highlight-text">$1</span>')+(e<r.t.length?'...':'');
        const el=document.createElement('div'); el.className='search-item'; el.innerHTML=`<div class="search-date">${d.toLocaleDateString()}</div><div class="search-snippet">${snip}</div>`;
        el.onclick=()=>{ document.getElementById('search-input').value=''; c.innerHTML=''; closeSettings(); selectDate(d); setTimeout(openDiary,300); }; c.appendChild(el);
    });
}
function openMonthGallery(){ 
    const v=document.getElementById('gallery-month-picker').value; if(!v)return alert("选月份"); 
    const g=document.getElementById('gallery-content'); g.innerHTML=''; 
    document.getElementById('month-gallery').classList.remove('hidden-right'); document.getElementById('settings-view').classList.add('hidden-right');
    const [y,m]=v.split('-'); const dim=new Date(y,m,0).getDate(); let has=false;
    for(let i=1;i<=dim;i++){
        const k=`${y}-${m}-${String(i).padStart(2,'0')}`; 
        if(state.diaryData[k]){ 
            has=true; createGalleryCard(g,state.diaryData[k],`${parseInt(m)}/${i}`,false,k); 
            if(state.diaryData[k].length>500) createGalleryCard(g,state.diaryData[k],'',true,k);
        }
    }
    if(!has)g.innerHTML='<div style="text-align:center;opacity:0.5;padding:50px">无记录</div>';
}
function createGalleryCard(c,txt,lbl,pg2,k){
    const w=document.createElement('div'); w.className=`gallery-card ${state.bgImage?'has-bg':''}`;
    const s=document.createElement('div'); s.className=`thumb-scaler ${pg2?'thumb-split-2':''}`;
    if(state.bgImage)s.style.backgroundImage=`url(${state.bgImage})`;
    const t=document.createElement('div'); t.innerHTML=txt; t.querySelectorAll('.sticker-item').forEach(x=>x.remove());
    s.innerHTML=(pg2?'':`<div class="thumb-date">${lbl}</div>`)+`<div class="thumb-text">${t.innerHTML}</div>`;
    w.appendChild(s); w.onclick=()=>{const[y,m,d]=k.split('-');closeMonthGallery();selectDate(new Date(y,m-1,d));setTimeout(openDiary,300);}; c.appendChild(w);
}
function closeMonthGallery(){ document.getElementById('month-gallery').classList.add('hidden-right'); toggleUI(true); }
function exportDiaryImage(){
    const d=document.getElementById('export-date-picker').value; if(!d)return alert("选日期");
    const [y,m,day]=d.split('-'); const k=formatDateKey(new Date(y,m-1,day)); const c=state.diaryData[k]; if(!c)return alert("无日记");
    showToast("生成中..."); const con=document.getElementById('screenshot-container'); con.innerHTML='';
    const p=document.createElement('div'); p.className=`paper-container ${state.settings.paper}`; if(state.bgImage){p.style.backgroundImage=`url(${state.bgImage})`;p.classList.add('has-custom-bg');}
    p.style.height='auto'; p.style.minHeight='800px'; p.style.position='relative'; p.innerHTML=`<div class="paper-header"><span class="date-display">${y}年${m}月${day}日</span></div><div class="paper-content" style="overflow:visible">${c}</div>`;
    con.appendChild(p);
    html2canvas(p,{scale:2,useCORS:true,backgroundColor:state.settings.theme==='theme-beige'?'#fffbf0':null}).then(cvs=>{const l=document.createElement('a');l.download=`diary_${k}.png`;l.href=cvs.toDataURL();l.click();con.innerHTML='';showToast("已保存");}).catch(()=>{alert("失败");con.innerHTML='';});
}

// 启动
init();
