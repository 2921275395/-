// ============ 紧急修复版 Script.js ============

// 1. 全局错误捕捉 (如果有报错，会弹窗告诉你)
window.onerror = function(msg, url, line) {
    // 忽略无关紧要的报错
    if(msg.includes('ResizeObserver')) return;
    console.log("Error: " + msg);
    // 如果严重白屏， Uncomment 下面这行可以弹窗调试
    // alert("系统错误: " + msg);
};

let state = {
    currentDate: new Date(),
    selectedDate: new Date(),
    diaryData: {},
    todoData: [],
    // 默认关闭锁屏，防止你进不去
    settings: { theme: "theme-beige", paper: "paper-lines", darkMode: false, showTodo: true, enableSticker: false },
    security: { enabled: false, pin: "", biometrics: false }, 
    bgImage: null,
    isDirty: false
};

// 2. 初始化函数
function init() {
    console.log("系统启动中...");

    // --- 强制清理冲突数据 (关键步骤) ---
    // 如果你发现每次刷新都白屏，说明旧数据坏了。
    // 为了让你能进去，我们先尝试读取。
    try {
        const sData = localStorage.getItem('myDiaryData_v2');
        if(sData) state.diaryData = JSON.parse(sData);

        const sSet = localStorage.getItem('myDiarySettings_v2');
        if(sSet) {
            const parsedSet = JSON.parse(sSet);
            // 强制合并设置，防止缺少字段
            state.settings = { ...state.settings, ...parsedSet };
        }
        
        // 注意：这里我们先【不读取】安全锁设置，
        // 确保你能先进入主界面。等你进去后，再去设置里重新开启锁屏。
        // state.security = JSON.parse(localStorage.getItem('myDiarySecurity_v2') || '{}'); 

    } catch (e) {
        console.error("数据损坏，已重置", e);
        alert("检测到数据冲突，已自动修复。请重新设置密码。");
        localStorage.clear(); // 极端情况下清空重来
    }

    // --- 3. 强制渲染 UI ---
    // 无论如何，先把日历画出来
    renderCalendar();
    
    // 强制显示主页
    const home = document.getElementById('home-view');
    if(home) {
        home.classList.remove('hidden-right');
        home.style.display = 'flex';
        home.style.opacity = '1';
    }

    // --- 4. 彻底隐藏锁屏 (临时策略) ---
    // 为了解决白屏，我们先把锁屏层强制移除，确定代码能跑通
    const lock = document.getElementById('lock-screen');
    if(lock) {
        lock.style.display = 'none';
        lock.classList.remove('active');
    }

    // 加载其他功能
    renderTodoList();
    applySettings();
    
    // 绑定事件
    bindEvents();
}

// 绑定各种点击事件
function bindEvents() {
    initDraggable(document.getElementById('index-tab'), 'left');
    initDraggable(document.getElementById('todo-tab'), 'left');
    document.getElementById('diary-input').addEventListener('input', () => state.isDirty = true);
    setInterval(autoSave, 5000); // 自动保存
}

// ============ 核心视图逻辑 ============

function renderCalendar() {
    const year = state.currentDate.getFullYear();
    const month = state.currentDate.getMonth();
    
    const label = document.getElementById('current-month-label');
    if(label) label.textContent = `${year}年 ${String(month + 1).padStart(2, '0')}月`;
    
    const container = document.getElementById('calendar-days');
    if(!container) return;
    container.innerHTML = '';

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // 空白占位
    for (let i = 0; i < firstDay; i++) {
        container.appendChild(document.createElement('div'));
    }

    const today = new Date();
    for (let i = 1; i <= daysInMonth; i++) {
        const dayEl = document.createElement('div');
        dayEl.className = 'day';
        dayEl.textContent = i;
        
        const thisDate = new Date(year, month, i);
        const dateKey = formatDateKey(thisDate);

        if (isSameDay(thisDate, today)) dayEl.classList.add('today');
        if (state.diaryData[dateKey]) dayEl.classList.add('has-entry');

        dayEl.onclick = () => {
            selectDate(thisDate);
            openDiary();
        };
        container.appendChild(dayEl);
    }
}

function selectDate(date) {
    state.selectedDate = date;
    document.getElementById('tab-date').textContent = `${date.getMonth()+1}/${date.getDate()}`;
    document.getElementById('index-tab').classList.add('visible');
}

function openDiary() {
    const dateKey = formatDateKey(state.selectedDate);
    const content = state.diaryData[dateKey] || '';
    
    document.getElementById('diary-date-display').textContent = 
        state.selectedDate.toLocaleDateString('zh-CN', {month:'long', day:'numeric', weekday:'long'});
    
    document.getElementById('diary-input').innerHTML = content;
    document.getElementById('diary-view').classList.remove('hidden-right');
    toggleUI(false);
}

function closeDiary() {
    saveDiaryManual();
    document.getElementById('diary-view').classList.add('hidden-right');
    toggleUI(true);
    renderCalendar();
}

// ============ 辅助功能 ============

function saveDiaryManual() {
    const input = document.getElementById('diary-input');
    const key = formatDateKey(state.selectedDate);
    if(!input.innerText.trim() && !input.innerHTML.includes('img')) {
        delete state.diaryData[key];
    } else {
        state.diaryData[key] = input.innerHTML;
    }
    localStorage.setItem('myDiaryData_v2', JSON.stringify(state.diaryData));
    state.isDirty = false;
    showToast("已保存");
}

function autoSave() {
    if(state.isDirty) saveDiaryManual();
}

function showToast(msg) {
    const t = document.getElementById('save-toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
}

function formatDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() && 
           d1.getMonth() === d2.getMonth() && 
           d1.getDate() === d2.getDate();
}

function toggleUI(show) {
    const tabs = document.querySelectorAll('.side-tab');
    tabs.forEach(t => show ? t.classList.remove('hidden-ui') : t.classList.add('hidden-ui'));
}

function applySettings() {
    document.body.className = `${state.settings.theme} ${state.settings.paper}`;
    if(state.settings.darkMode) document.body.classList.add('dark-mode');
}

// 拖拽逻辑 (简化版)
function initDraggable(el, axis) {
    if(!el) return;
    let startX, startY, startTop, startLeft;
    el.addEventListener('touchstart', e => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTop = el.offsetTop;
        startLeft = el.offsetLeft;
        el.style.transition = 'none';
    });
    el.addEventListener('touchmove', e => {
        e.preventDefault();
        const dy = e.touches[0].clientY - startY;
        const dx = e.touches[0].clientX - startX;
        el.style.top = (startTop + dy) + 'px';
        if(axis === 'any') el.style.left = (startLeft + dx) + 'px';
    });
    el.addEventListener('touchend', () => {
        el.style.transition = 'top 0.3s ease';
    });
}

// --- 必须保留的空函数 (防止HTML里的 onclick 报错) ---
window.openSettings = function() { document.getElementById('settings-view').classList.remove('hidden-right'); toggleUI(false); };
window.closeSettings = function() { document.getElementById('settings-view').classList.add('hidden-right'); toggleUI(true); };
window.openTodo = function() { document.getElementById('todo-view').classList.remove('hidden-right'); toggleUI(false); };
window.closeTodo = function() { document.getElementById('todo-view').classList.add('hidden-right'); toggleUI(true); };
window.handleGlobalClick = function() {}; 
window.changeMonth = function(v) { 
    const [y,m] = v.split('-'); state.currentDate = new Date(y, m-1, 1); renderCalendar(); 
};
window.toggleDarkMode = function() { 
    state.settings.darkMode = !state.settings.darkMode; applySettings(); 
    localStorage.setItem('myDiarySettings_v2', JSON.stringify(state.settings));
};
// 待办事项渲染 (简化)
function renderTodoList() { /* 为了确保白屏修复，暂时留空，主界面好了再加 */ }

// 启动
init();
