(() => {
  'use strict';

  const BACKUP_INTERVAL_DAYS = 30;
  const DEFAULT_PREFS = { theme: 'light', completedOpen: false, lastBackupAt: '', lastSavedAt: '' };
  const fileSync = new window.DailyTodoFileSync();
  const todayISO = () => toISO(new Date());
  const uid = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const state = {
    tasks: [],
    prefs: { ...DEFAULT_PREFS },
    ready: false,
    saveState: 'loading',
    fileSyncMode: 'checking',
    requiresLocalServer: false,
    lastConfirmedSnapshot: null,
    pendingSnapshot: null,
    snapshotState: 'healthy',
    saveRevision: 0,
    view: 'today',
    selectedDate: todayISO(),
    calendarMonth: toMonthISO(new Date()),
    drawerOpen: false,
    editingId: null,
    searchOpen: false,
    searchText: '',
    toast: null,
  };

  const app = document.getElementById('app');
  render();
  void bootstrap();

  if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  window.addEventListener('beforeunload', event => {
    if (!state.pendingSnapshot) return;
    event.preventDefault();
    event.returnValue = '';
  });

  async function bootstrap() {
    const fileResult = await fileSync.load();
    if (!fileResult.available) {
      state.ready = true;
      state.requiresLocalServer = true;
      state.fileSyncMode = 'unavailable';
      state.saveState = 'error';
      render();
      return;
    }

    const snapshot = fileResult.snapshot || { tasks: [], prefs: { ...DEFAULT_PREFS } };
    state.tasks = snapshot.tasks.map(normalizeTask);
    state.prefs = { ...DEFAULT_PREFS, ...snapshot.prefs };
    state.fileSyncMode = 'synced';
    state.snapshotState = fileResult.snapshotSaved === false ? 'degraded' : 'healthy';
    state.lastConfirmedSnapshot = cloneSnapshot(snapshot);
    state.pendingSnapshot = null;
    state.saveState = 'saved';
    if (state.prefs.theme === 'dark') document.documentElement.dataset.theme = 'dark';
    state.ready = true;
    render();
  }

  function persist() {
    const revision = ++state.saveRevision;
    state.prefs.lastSavedAt = new Date().toISOString();
    state.saveState = 'saving';
    const snapshot = { tasks: state.tasks, prefs: state.prefs };
    state.pendingSnapshot = cloneSnapshot(snapshot);

    void fileSync.save(snapshot)
      .then(result => {
        if (revision !== state.saveRevision) return;
        state.fileSyncMode = fileSyncStatus(result);
        updateSnapshotState(result);
        state.saveState = result.synced ? 'saved' : 'error';
        if (result.synced) {
          state.lastConfirmedSnapshot = cloneSnapshot(snapshot);
          state.pendingSnapshot = null;
        }
        refreshSaveFeedback();
      })
      .catch(error => {
        if (revision !== state.saveRevision) return;
        console.error('Unable to save Daily Todo data.', error);
        state.fileSyncMode = 'error';
        state.saveState = 'error';
        refreshSaveFeedback();
      });
  }

  function cloneSnapshot(snapshot) {
    return JSON.parse(JSON.stringify(snapshot));
  }

  function ensureWritable() {
    if (!state.pendingSnapshot) return true;
    showToast('数据文件尚未确认保存。请先重试同步或导出备份。');
    return false;
  }

  function fileSyncStatus(result) {
    if (result.conflict) return 'conflict';
    if (result.synced) return 'synced';
    if (result.available) return 'error';
    return 'unavailable';
  }

  function updateSnapshotState(result) {
    if (typeof result.snapshotSaved !== 'boolean') return;
    state.snapshotState = result.snapshotSaved ? 'healthy' : 'degraded';
  }

  async function retryFileSync() {
    if (state.fileSyncMode === 'conflict') {
      showToast('存在同步冲突。请先导出当前待保存数据，再刷新页面。');
      return;
    }
    state.fileSyncMode = 'retrying';
    render();
    const result = await fileSync.save({ tasks: state.tasks, prefs: state.prefs });
    state.fileSyncMode = fileSyncStatus(result);
    updateSnapshotState(result);
    state.saveState = result.synced ? 'saved' : 'error';
    if (result.synced) {
      state.lastConfirmedSnapshot = cloneSnapshot({ tasks: state.tasks, prefs: state.prefs });
      state.pendingSnapshot = null;
    }
    render();
    showToast(result.synced ? '项目内数据文件已同步' : '项目内数据文件暂未同步，请稍后重试。');
  }

  function refreshSaveFeedback() {
    document.querySelectorAll('[data-save-status]').forEach(element => {
      element.outerHTML = saveStatusHTML();
    });
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '未知时间';
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  function isBackupDue() {
    if (!state.tasks.length) return false;
    const lastBackup = new Date(state.prefs.lastBackupAt).getTime();
    return Number.isNaN(lastBackup) || Date.now() - lastBackup >= BACKUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  }

  function saveStatusHTML() {
    if (state.saveState === 'saving') return '<p class="save-status" data-save-status role="status">正在写入本地数据文件…</p>';
    if (state.saveState === 'error') return '<p class="save-status is-error" data-save-status role="status">本地数据文件未保存</p>';
    if (state.fileSyncMode === 'conflict') return '<p class="save-status is-warning" data-save-status role="status">数据文件存在冲突，请刷新</p>';
    const savedAt = state.prefs.lastSavedAt ? ` · ${formatDateTime(state.prefs.lastSavedAt)}` : '';
    return `<p class="save-status" data-save-status role="status">${icon('check', 15)} 本地文件已保存${savedAt}</p>`;
  }

  function toISO(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function fromISO(value) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toMonthISO(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function fromMonthISO(value) {
    const [year, month] = value.split('-').map(Number);
    return new Date(year, month - 1, 1);
  }

  function addMonths(value, amount) {
    const date = fromMonthISO(value);
    date.setMonth(date.getMonth() + amount);
    return toMonthISO(date);
  }

  function monthLabel(value) {
    const date = fromMonthISO(value);
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function addDays(value, amount) {
    const d = typeof value === 'string' ? fromISO(value) : new Date(value);
    d.setDate(d.getDate() + amount);
    return toISO(d);
  }

  function weekStart(value) {
    const d = fromISO(value);
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return d;
  }

  function isSameWeek(dateA, dateB) {
    const startA = toISO(weekStart(dateA));
    const startB = toISO(weekStart(dateB));
    return startA === startB;
  }

  function formatWeekRange(startISO) {
    const start = fromISO(startISO);
    const end = fromISO(addDays(startISO, 6));
    const startY = start.getFullYear();
    const endY = end.getFullYear();
    const startM = start.getMonth() + 1;
    const endM = end.getMonth() + 1;
    if (startY !== endY) {
      return `${startY}年${startM}月${start.getDate()}日 - ${endY}年${endM}月${end.getDate()}日`;
    }
    if (startM !== endM) {
      return `${startY}年${startM}月${start.getDate()}日 - ${endM}月${end.getDate()}日`;
    }
    return `${startY}年${startM}月 · ${start.getDate()}日 - ${end.getDate()}日`;
  }

  function zhWeek(d) {
    return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  }

  function niceDate(value, long = false) {
    const d = fromISO(value);
    if (value === todayISO()) return long ? `今天 · ${d.getMonth() + 1}月${d.getDate()}日` : '今天';
    if (value === addDays(todayISO(), 1)) return long ? `明天 · ${d.getMonth() + 1}月${d.getDate()}日` : '明天';
    return `${d.getMonth() + 1}月${d.getDate()}日${long ? ` · 星期${zhWeek(d)}` : ''}`;
  }

  function escapeHTML(value = '') {
    return String(value).replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
  }

  function icon(name, size = 18) {
    const icons = {
      today: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>',
      calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
      check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
      settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 9.2 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 3.8 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2V9.6h.1A1.7 1.7 0 0 0 3.2 9a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.2 3.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2h4v.1A1.7 1.7 0 0 0 14 3.2a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.2a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.1.4 1.7 1.7 0 0 0-.6 1Z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      chevron: '<path d="m9 18 6-6-6-6"/>',
      chevronLeft: '<path d="m15 18-6-6 6-6"/>',
      chevronRight: '<path d="m9 18 6-6-6-6"/>',
      arrowLeft: '<path d="m15 18-6-6 6-6"/><path d="M9 12h11"/>',
      arrowRight: '<path d="m9 18 6-6-6-6"/><path d="M4 12h11"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      moon: '<path d="M21 12.8A8.7 8.7 0 1 1 11.2 3 6.8 6.8 0 0 0 21 12.8Z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
      upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
  }

  function render() {
    if (!state.ready) {
      app.innerHTML = `<main class="loading-screen" aria-live="polite"><div><span class="brand-mark">D</span><strong>正在连接本地数据文件</strong><span>正在检查程序目录中的数据库…</span></div></main>`;
      return;
    }
    if (state.requiresLocalServer) {
      app.innerHTML = serverRequiredHTML();
      return;
    }

    app.innerHTML = `
      <div class="app-shell">
        ${sidebarHTML()}
        <main class="main">
          <header class="topbar">
            <div class="mobile-brand"><span class="brand-mark small">D</span><strong>Daily</strong></div>
            <div class="top-actions">
              ${saveStatusHTML()}
              <button class="icon-button" data-action="open-search" aria-label="搜索">${icon('search')}</button>
              <button class="button primary compact desktop-create" data-action="new-task">${icon('plus', 16)}<span>新建</span></button>
            </div>
          </header>
          <div class="content">${pageHTML()}</div>
          ${mobileNavHTML()}
        </main>
      </div>
      ${state.drawerOpen ? drawerHTML() : ''}
      ${state.searchOpen ? searchHTML() : ''}
      ${state.toast ? toastHTML() : ''}
    `;
    bindEvents();
  }

  function serverRequiredHTML() {
    return `<main class="server-required-screen"><section class="server-required-card"><span class="brand-mark">D</span><span class="eyebrow">需要本地数据服务</span><h1>请通过启动器打开 Daily Todo</h1><p>为了确保清空浏览器缓存也不会丢失任务，本版本不使用浏览器数据库。所有任务只保存到程序目录的 <code>data/daily-todo-data.json</code>。</p><ol><li>关闭当前页面。</li><li>双击程序目录中的 <strong>start-daily-todo.bat</strong>。</li><li>在自动打开的 <strong>http://localhost:8080</strong> 页面中使用。</li></ol><p class="server-required-note">直接双击 index.html 不会加载或保存任何任务数据。</p></section></main>`;
  }

  function sidebarHTML() {
    return `
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">D</span><span>Daily</span></div>
        <nav>
          ${navButton('today', 'today', '今天')}
          ${navButton('calendar', 'calendar', '日历')}
          ${navButton('completed', 'check', '已完成')}
        </nav>
        <div class="sidebar-bottom">${navButton('settings', 'settings', '设置')}</div>
      </aside>`;
  }

  function navButton(view, iconName, label) {
    return `<button class="nav-button ${state.view === view ? 'active' : ''}" data-view="${view}">${icon(iconName)}<span>${label}</span></button>`;
  }

  function mobileNavHTML() {
    return `
      <nav class="mobile-nav">
        ${navButton('today', 'today', '今天')}
        ${navButton('calendar', 'calendar', '日历')}
        <button class="mobile-add" data-action="new-task" aria-label="新建任务">${icon('plus',22)}</button>
        ${navButton('completed', 'check', '完成')}
        ${navButton('settings', 'settings', '设置')}
      </nav>`;
  }

  function pageHTML() {
    if (state.view === 'today') return todayPageHTML();
    if (state.view === 'calendar') return calendarPageHTML();
    if (state.view === 'completed') return completedHTML();
    return settingsHTML();
  }

  function headingHTML(eyebrow, title, subtitle, right = '') {
    return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p>${subtitle}</p></div>${right}</div>`;
  }

  function todayPageHTML() {
    const dayTasks = state.tasks.filter(t => t.date === state.selectedDate);
    const active = sortTasks(dayTasks.filter(t => !t.completed));
    const completed = dayTasks.filter(t => t.completed);
    const d = fromISO(state.selectedDate);
    const right = `<div class="progress-copy"><strong>${completed.length}</strong><span>/ ${dayTasks.length} 完成</span></div>`;
    const isToday = state.selectedDate === todayISO();
    const title = `${d.getMonth()+1}月${d.getDate()}日 星期${zhWeek(d)}`;
    let subtitle;
    if (active.length > 0) {
      subtitle = `还有 ${active.length} 项任务待完成`;
    } else if (dayTasks.length > 0) {
      subtitle = isToday ? '今天的任务已经全部完成' : '这一天的任务已全部完成';
    } else {
      subtitle = isToday ? '今天暂无待办任务' : '这一天暂无任务';
    }

    return `<section class="page today-page">
      ${headingHTML(state.selectedDate === todayISO() ? '今天' : '日期', title, subtitle, right)}
      ${weekStripHTML()}
      <form class="quick-add" id="quick-add-form">
        ${icon('plus')}
        <input id="quick-title" autocomplete="off" placeholder="添加一个任务，按 Enter 创建" />
        <button type="submit">添加</button>
      </form>
      <div class="task-section">
        <div class="section-label"><span>待完成</span><small>${active.length}</small></div>
        <div class="task-list">${active.length ? active.map(taskHTML).join('') : emptyHTML('check','没有待办了','可以休息一下，或者添加新的任务。')}</div>
      </div>
      ${completed.length ? `<div class="completed-section"><button class="completed-toggle" data-action="toggle-completed"><span>已完成 ${completed.length}</span><span class="chev ${state.prefs.completedOpen ? 'rotate' : ''}">${icon('chevron',17)}</span></button>${state.prefs.completedOpen ? `<div class="task-list completed-list">${completed.map(taskHTML).join('')}</div>` : ''}</div>` : ''}
    </section>`;
  }

  function weekStripHTML() {
    const start = weekStart(state.selectedDate);
    const startValue = toISO(start);
    const isThisWeek = isSameWeek(state.selectedDate, todayISO());
    const rangeLabel = formatWeekRange(startValue);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const value = toISO(d);
      const isSelected = value === state.selectedDate;
      const isToday = value === todayISO();

      const dayTasks = state.tasks.filter(t => t.date === value);
      const activeCount = dayTasks.filter(t => !t.completed).length;
      const completedCount = dayTasks.length - activeCount;

      let dotsHTML = '';
      if (activeCount > 0 || completedCount > 0) {
        dotsHTML = `<span class="day-dots" aria-hidden="true">${activeCount > 0 ? '<i class="is-active"></i>' : ''}${completedCount > 0 ? '<i class="is-complete"></i>' : ''}</span>`;
      } else {
        dotsHTML = '<span class="day-dots empty" aria-hidden="true"></span>';
      }

      days.push(`
        <button class="week-day-btn ${isSelected ? 'selected' : ''} ${isToday ? 'is-today' : ''}" data-date="${value}" aria-pressed="${isSelected}" aria-label="${value === todayISO() ? '今天 ' : ''}${d.getMonth() + 1}月${d.getDate()}日 星期${zhWeek(d)}，${activeCount} 项待完成，${completedCount} 项已完成">
          <span class="day-name">${zhWeek(d)}</span>
          <strong class="day-number">${d.getDate()}</strong>
          ${dotsHTML}
        </button>
      `);
    }

    return `
      <div class="week-card" id="week-card">
        <div class="week-card-header">
          <div class="week-stepper">
            <button class="icon-button stepper-btn" data-action="week-prev" aria-label="上一周">${icon('chevronLeft', 16)}</button>
            <span class="week-range-text">${rangeLabel}</span>
            <button class="icon-button stepper-btn" data-action="week-next" aria-label="下一周">${icon('chevronRight', 16)}</button>
          </div>
          <div class="week-header-actions">
            ${!isThisWeek ? `<button class="week-today-pill" data-action="week-today">${icon('today', 13)}<span>回到今天</span></button>` : ''}
          </div>
        </div>
        <div class="week-strip">
          ${days.join('')}
        </div>
      </div>
    `;
  }

  function sortTasks(items) {
    return [...items].sort((a,b) => Number(b.important)-Number(a.important) || String(a.time || '99:99').localeCompare(String(b.time || '99:99')) || a.createdAt.localeCompare(b.createdAt));
  }

  function taskHTML(task) {
    return `<div class="task-row ${task.completed ? 'is-complete' : ''}" data-task-row="${escapeHTML(task.id)}">
      <button class="check-hit" data-action="toggle-task" data-id="${escapeHTML(task.id)}" aria-label="${task.completed ? '标记未完成' : '标记完成'}"><span class="check ${task.completed ? 'checked' : ''}">${task.completed ? '✓' : ''}</span></button>
      <button class="task-main" data-action="edit-task" data-id="${escapeHTML(task.id)}"><span class="task-title">${escapeHTML(task.title)}</span>${task.notes ? `<span class="task-notes">${escapeHTML(task.notes)}</span>` : ''}</button>
      <div class="task-meta">
        ${task.time ? `<span class="time">${icon('clock',14)}${escapeHTML(task.time)}</span>` : ''}
        <button class="icon-button subtle ${task.important ? 'active' : ''}" data-action="important-task" data-id="${escapeHTML(task.id)}" aria-label="重要">${icon('star',17)}</button>
        <div class="task-menu-wrap">
          <button class="icon-button subtle menu-trigger" aria-label="更多">${icon('more')}</button>
          <div class="task-menu">
            <button data-action="edit-task" data-id="${escapeHTML(task.id)}">编辑</button>
            <button data-action="tomorrow-task" data-id="${escapeHTML(task.id)}">移到明天</button>
            <button class="danger" data-action="delete-task" data-id="${escapeHTML(task.id)}">删除</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function emptyHTML(iconName, title, subtitle) {
    return `<div class="empty-state">${icon(iconName,30)}<strong>${title}</strong><span>${subtitle}</span></div>`;
  }

  function calendarPageHTML() {
    const selectedTasks = state.tasks.filter(task => task.date === state.selectedDate);
    const activeTasks = sortTasks(selectedTasks.filter(task => !task.completed));
    const completedTasks = sortTasks(selectedTasks.filter(task => task.completed));
    const controls = `<div class="calendar-controls"><button class="icon-button" data-action="calendar-previous" aria-label="上个月">${icon('arrowLeft')}</button><input id="calendar-month-picker" type="month" value="${state.calendarMonth}" aria-label="选择月份" /><button class="icon-button" data-action="calendar-next" aria-label="下个月">${icon('arrowRight')}</button><button class="button secondary compact" data-action="calendar-today">今天</button></div>`;
    return `<section class="page calendar-page">
      ${headingHTML('计划', '日历', '选择任意一天，回顾过去或安排未来。', controls)}
      <div class="calendar-card">
        <div class="calendar-month-title"><strong>${monthLabel(state.calendarMonth)}</strong><span>有任务的日期会显示数量</span></div>
        <div class="calendar-weekdays" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
        <div class="calendar-grid">${calendarGridHTML()}</div>
      </div>
      ${calendarDetailHTML(activeTasks, completedTasks)}
    </section>`;
  }

  function calendarGridHTML() {
    const monthStart = fromMonthISO(state.calendarMonth);
    const firstDayOffset = (monthStart.getDay() + 6) % 7;
    const gridStart = new Date(monthStart);
    gridStart.setDate(gridStart.getDate() - firstDayOffset);
    const days = [];

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      const value = toISO(date);
      const tasks = state.tasks.filter(task => task.date === value);
      const active = tasks.filter(task => !task.completed).length;
      const completed = tasks.length - active;
      const isCurrentMonth = toMonthISO(date) === state.calendarMonth;
      const isSelected = value === state.selectedDate;
      const isToday = value === todayISO();
      const details = tasks.length ? `，${active} 项待完成，${completed} 项已完成` : '，没有任务';
      days.push(`<button class="calendar-day ${isCurrentMonth ? '' : 'is-outside'} ${isSelected ? 'is-selected' : ''} ${isToday ? 'is-today' : ''}" data-calendar-date="${value}" aria-pressed="${isSelected}" aria-label="${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${details}"><span class="calendar-day-number">${date.getDate()}</span><span class="calendar-day-count">${tasks.length ? `${tasks.length} 项` : ''}</span><span class="calendar-day-dots" aria-hidden="true">${active ? '<i class="is-active"></i>' : ''}${completed ? '<i class="is-complete"></i>' : ''}</span></button>`);
    }
    return days.join('');
  }

  function calendarDetailHTML(activeTasks, completedTasks) {
    const total = activeTasks.length + completedTasks.length;
    const subtitle = total ? `${activeTasks.length} 项待完成 · ${completedTasks.length} 项已完成` : '这一天还没有任务';
    return `<section class="calendar-detail" aria-labelledby="calendar-detail-title">
      <div class="calendar-detail-heading"><div><span class="eyebrow">已选日期</span><h2 id="calendar-detail-title">${niceDate(state.selectedDate, true)}</h2><p>${subtitle}</p></div><button class="button secondary compact" data-action="new-task">${icon('plus', 16)} 添加任务</button></div>
      <div class="calendar-task-groups">
        <div class="calendar-task-group"><div class="section-label"><span>待完成</span><small>${activeTasks.length}</small></div><div class="task-list">${activeTasks.length ? activeTasks.map(taskHTML).join('') : emptyHTML('check', '没有待完成任务', '可为这一天添加一项计划。')}</div></div>
        ${completedTasks.length ? `<div class="calendar-task-group"><div class="section-label"><span>已完成</span><small>${completedTasks.length}</small></div><div class="task-list">${completedTasks.map(taskHTML).join('')}</div></div>` : ''}
      </div>
    </section>`;
  }
  function completedHTML() {
    const items = [...state.tasks].filter(t => t.completed).sort((a,b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
    return `<section class="page">${headingHTML('历史','已完成','最近完成的任务会保留在这里。')}<div class="task-list">${items.length ? items.map(taskHTML).join('') : emptyHTML('check','还没有完成记录','完成第一个任务后会显示在这里。')}</div></section>`;
  }

  function settingsHTML() {
    const dark = state.prefs.theme === 'dark';
    const isFileSynced = state.fileSyncMode === 'synced';
    const fileConflict = state.fileSyncMode === 'conflict';
    const fileError = state.fileSyncMode === 'error';
    const snapshotDegraded = state.snapshotState === 'degraded';
    const backupText = state.prefs.lastBackupAt ? `上次导出：${formatDateTime(state.prefs.lastBackupAt)}` : '建议定期下载 JSON 备份';
    const fileText = isFileSynced
      ? `当前数据库：data/daily-todo-data.json${state.prefs.lastSavedAt ? ` · ${formatDateTime(state.prefs.lastSavedAt)}` : ''}`
      : fileConflict
        ? '检测到其他标签已更新数据文件。当前待保存改动仍在本页面内，请先导出后再刷新。'
        : fileError
          ? '数据文件暂未写入。当前改动仍留在本页面内；请先重试或导出，再关闭或刷新。'
          : '本地数据服务不可用。请检查 start-daily-todo.bat 是否仍在运行。';
    const fileBadge = isFileSynced ? '已同步' : fileConflict ? '需刷新' : fileError ? '需重试' : '服务离线';
    const fileAction = fileError ? '<button class="button secondary" data-action="retry-file-sync">重试同步</button>' : '<span class="storage-badge ' + (isFileSynced ? '' : 'is-error') + '">' + fileBadge + '</span>';
    return `<section class="page settings-page">
      ${headingHTML('偏好', '设置', '所有任务仅写入程序目录的数据文件。')}
      <div class="settings-card">
        <div class="setting-row"><div><strong>本地数据库文件</strong><span>${fileText}</span></div>${fileAction}</div>
        <div class="setting-row"><div><strong>每日恢复快照</strong><span>${snapshotDegraded ? '当前数据库已保存，但今日恢复快照未能生成；下次保存会自动重试。' : 'data/backups/ 中保留当天及之前 89 个日历日'}</span></div><span class="storage-badge ${snapshotDegraded ? 'is-error' : ''}">${snapshotDegraded ? '需修复' : '90 天'}</span></div>
        <div class="setting-row"><div><strong>外观</strong><span>切换浅色和深色模式</span></div><button class="button secondary" data-action="toggle-theme">${icon(dark ? 'sun' : 'moon', 16)} ${dark ? '浅色' : '深色'}</button></div>
        <div class="setting-row"><div><strong>导出备份</strong><span>${backupText}</span></div><button class="button secondary" data-action="export-data">${icon('download', 16)} 立即备份</button></div>
        <div class="setting-row"><div><strong>导入数据</strong><span>从之前导出的 JSON 恢复</span></div><button class="button secondary" data-action="import-data">${icon('upload', 16)} 导入</button></div>
        <div class="setting-row warning-row"><div><strong>清空数据</strong><span>清空程序目录中的当前数据文件和本页面任务</span></div><button class="button danger-button" data-action="clear-data">${icon('trash', 16)} 清空</button></div>
        <input id="import-file" type="file" accept="application/json" hidden />
      </div>
      ${isBackupDue() ? '<div class="backup-reminder"><strong>建议额外导出一次</strong><span>项目内文件保护本机数据；JSON 导出适合复制到另一台设备或异地保存。</span></div>' : ''}
      <div class="settings-note">浏览器缓存只包含界面资源。清空浏览器缓存不会删除 data/ 文件夹中的任务数据。</div>
    </section>`;
  }
  function sortByDate(items) { return [...items].sort((a,b) => a.date.localeCompare(b.date)); }
  function groupByDate(items) {
    const map = new Map();
    items.forEach(task => { if (!map.has(task.date)) map.set(task.date, []); map.get(task.date).push(task); });
    return [...map.entries()];
  }

  function drawerHTML() {
    const task = state.tasks.find(t => t.id === state.editingId) || null;
    return `<div class="drawer-layer" data-layer="drawer">
      <aside class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-header"><div><span class="eyebrow">${task ? '编辑任务' : '新建任务'}</span><h2>${task ? '调整任务' : '添加到计划'}</h2></div><button class="icon-button" data-action="close-drawer">${icon('close')}</button></div>
        <form class="task-form" id="task-form">
          <label><span>任务名称</span><input id="field-title" autocomplete="off" autofocus value="${escapeHTML(task?.title || '')}" placeholder="例如：完成英语作业" /></label>
          <div class="form-grid">
            <label><span>日期</span><input id="field-date" type="date" value="${escapeHTML(task?.date || state.selectedDate)}" /></label>
            <label><span>时间</span><input id="field-time" type="time" value="${escapeHTML(task?.time || '')}" /></label>
          </div>
          <label><span>重复</span><select id="field-repeat"><option value="none">不重复</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option></select></label>
          <label><span>备注</span><textarea id="field-notes" rows="5" placeholder="可选备注">${escapeHTML(task?.notes || '')}</textarea></label>
          <label class="switch-row"><span><strong>重要任务</strong><small>在任务列表中优先显示</small></span><input id="field-important" type="checkbox" ${task?.important ? 'checked' : ''} /></label>
          <div class="drawer-actions"><button type="button" class="button secondary" data-action="close-drawer">取消</button><button class="button primary" type="submit">${task ? '保存修改' : '创建任务'}</button></div>
        </form>
      </aside>
    </div>`;
  }

  function searchHTML() {
    const q = state.searchText.trim().toLowerCase();
    const results = q ? state.tasks.filter(t => t.title.toLowerCase().includes(q) || String(t.notes || '').toLowerCase().includes(q)).slice(0, 14) : [];
    return `<div class="search-layer" data-layer="search"><div class="search-panel"><div class="search-input">${icon('search')}<input id="search-box" autocomplete="off" placeholder="搜索任务" value="${escapeHTML(state.searchText)}"/><button class="icon-button" data-action="close-search">${icon('close',17)}</button></div><div class="search-results">${q ? (results.length ? results.map(t => `<button data-action="search-open-task" data-id="${escapeHTML(t.id)}"><span><strong>${escapeHTML(t.title)}</strong><small>${niceDate(t.date, true)}</small></span><em>${t.completed ? '已完成' : '待完成'}</em></button>`).join('') : '<div class="search-hint">没有找到匹配任务</div>') : '<div class="search-hint">输入任务名称或备注开始搜索</div>'}</div></div></div>`;
  }

  function toastHTML() {
    return `<div class="toast"><span>${escapeHTML(state.toast.text)}</span>${state.toast.undoId ? `<button data-action="undo-complete" data-id="${escapeHTML(state.toast.undoId)}">撤销</button>` : ''}</div>`;
  }

  function bindEvents() {
    document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => {
      state.view = el.dataset.view;
      if (state.view === 'today') state.selectedDate = todayISO();
      if (state.view === 'calendar') state.calendarMonth = state.selectedDate.slice(0, 7);
      render();
    }));

    const weekStrip = document.querySelector('.week-strip');
    if (weekStrip) {
      let touchStartX = 0;
      let touchStartY = 0;
      let gestureActive = false;
      weekStrip.addEventListener('touchstart', e => {
        if (e.touches.length === 1) {
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          gestureActive = true;
        } else {
          gestureActive = false;
        }
      }, { passive: true });
      weekStrip.addEventListener('touchcancel', () => {
        gestureActive = false;
      }, { passive: true });
      weekStrip.addEventListener('touchend', e => {
        if (!gestureActive) return;
        gestureActive = false;
        if (e.changedTouches.length === 1) {
          const diffX = e.changedTouches[0].clientX - touchStartX;
          const diffY = e.changedTouches[0].clientY - touchStartY;
          if (Math.abs(diffX) > 48 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
            if (diffX > 0) {
              handleAction('week-prev');
            } else {
              handleAction('week-next');
            }
          }
        }
      }, { passive: true });
    }

    document.querySelectorAll('[data-date]').forEach(el => el.addEventListener('click', () => { state.selectedDate = el.dataset.date; render(); }));
    document.querySelectorAll('[data-calendar-date]').forEach(el => el.addEventListener('click', () => {
      state.selectedDate = el.dataset.calendarDate;
      state.calendarMonth = state.selectedDate.slice(0, 7);
      render();
    }));

    const monthPicker = document.getElementById('calendar-month-picker');
    if (monthPicker) monthPicker.addEventListener('change', () => {
      if (!monthPicker.value) return;
      selectCalendarMonth(monthPicker.value);
    });

    document.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', e => handleAction(e.currentTarget.dataset.action, e.currentTarget.dataset.id)));

    const quick = document.getElementById('quick-add-form');
    if (quick) quick.addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('quick-title');
      if (!ensureWritable()) return;
      const title = input.value.trim();
      if (!title) return;
      state.tasks.push(makeTask({ title, date: state.selectedDate }));
      persist(); render();
      setTimeout(() => document.getElementById('quick-title')?.focus(), 0);
    });

    const taskForm = document.getElementById('task-form');
    if (taskForm) {
      const task = state.tasks.find(t => t.id === state.editingId);
      const repeat = document.getElementById('field-repeat');
      if (repeat && task) repeat.value = task.repeat || 'none';
      taskForm.addEventListener('submit', e => {
        e.preventDefault();
        if (!ensureWritable()) return;
        const title = document.getElementById('field-title').value.trim();
        if (!title) { document.getElementById('field-title').focus(); return; }
        const data = {
          title,
          date: document.getElementById('field-date').value || state.selectedDate,
          time: document.getElementById('field-time').value || '',
          repeat: document.getElementById('field-repeat').value,
          notes: document.getElementById('field-notes').value.trim(),
          important: document.getElementById('field-important').checked,
        };
        if (task) Object.assign(task, data, { updatedAt: new Date().toISOString() });
        else state.tasks.push(makeTask(data));
        persist(); state.drawerOpen = false; state.editingId = null; render();
      });
      setTimeout(() => document.getElementById('field-title')?.focus(), 0);
    }

    const searchBox = document.getElementById('search-box');
    if (searchBox) {
      searchBox.addEventListener('input', e => { state.searchText = e.target.value; render(); setTimeout(() => { const box = document.getElementById('search-box'); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, 0); });
      setTimeout(() => searchBox.focus(), 0);
    }

    const importInput = document.getElementById('import-file');
    if (importInput) importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const importedTasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
        if (!Array.isArray(importedTasks)) throw new Error('bad format');
        state.tasks = importedTasks.map(normalizeTask);
        persist();
        showToast(`已导入 ${state.tasks.length} 条任务`);
      } catch {
        showToast('导入失败，请检查 JSON 文件');
      } finally {
        importInput.value = '';
      }
    });

    document.onkeydown = globalKeydown;

    document.querySelectorAll('[data-layer]').forEach(layer => layer.addEventListener('mousedown', e => {
      if (e.target !== layer) return;
      if (layer.dataset.layer === 'drawer') { state.drawerOpen = false; state.editingId = null; }
      if (layer.dataset.layer === 'search') { state.searchOpen = false; state.searchText = ''; }
      render();
    }));
  }

  function globalKeydown(e) {
    if (e.key === 'Escape') {
      if (state.drawerOpen) { state.drawerOpen = false; state.editingId = null; render(); return; }
      if (state.searchOpen) { state.searchOpen = false; state.searchText = ''; render(); return; }
    }
    if (e.key === '/' && !isTyping()) { e.preventDefault(); state.searchOpen = true; render(); return; }
    if ((e.key === 'n' || e.key === 'N') && !isTyping()) { e.preventDefault(); openNew(); }
  }

  function isTyping() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function makeTask(data) {
    const stamp = new Date().toISOString();
    return {
      id: uid(), title: '', date: todayISO(), time: '', notes: '', important: false,
      completed: false, completedAt: '', repeat: 'none', createdAt: stamp, updatedAt: stamp,
      ...data,
    };
  }

  function normalizeTask(value) {
    const source = value && typeof value === 'object' ? value : {};
    const task = makeTask({});
    const safeText = input => typeof input === 'string' ? input.slice(0, 20000) : '';
    const validDate = input => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) && !Number.isNaN(fromISO(input).getTime());
    const validTime = input => typeof input === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input);
    const validId = input => typeof input === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(input);
    const validRepeat = ['none', 'daily', 'weekdays', 'weekly'].includes(source.repeat) ? source.repeat : 'none';
    const validStamp = input => typeof input === 'string' && !Number.isNaN(new Date(input).getTime()) ? input : task.createdAt;

    return {
      ...task,
      id: validId(source.id) ? source.id : uid(),
      title: safeText(source.title).slice(0, 2000),
      date: validDate(source.date) ? source.date : todayISO(),
      time: validTime(source.time) ? source.time : '',
      notes: safeText(source.notes),
      important: source.important === true,
      completed: source.completed === true,
      completedAt: source.completed === true ? validStamp(source.completedAt) : '',
      repeat: validRepeat,
      createdAt: validStamp(source.createdAt),
      updatedAt: validStamp(source.updatedAt),
    };
  }

  function handleAction(action, id) {
    const nonMutatingActions = new Set(['week-prev', 'week-next', 'week-today', 'open-search', 'close-search', 'close-drawer', 'retry-file-sync', 'export-data']);
    if (state.pendingSnapshot && !nonMutatingActions.has(action)) {
      showToast('数据文件尚未确认保存。请先重试同步或导出备份。');
      return;
    }
    if (action === 'week-prev') {
      state.selectedDate = addDays(state.selectedDate, -7);
      render();
      requestAnimationFrame(() => {
        document.querySelector('[data-action="week-prev"]')?.focus();
      });
      return;
    }
    if (action === 'week-next') {
      state.selectedDate = addDays(state.selectedDate, 7);
      render();
      requestAnimationFrame(() => {
        document.querySelector('[data-action="week-next"]')?.focus();
      });
      return;
    }
    if (action === 'week-today') {
      state.selectedDate = todayISO();
      render();
      requestAnimationFrame(() => {
        document.querySelector(`[data-date="${state.selectedDate}"]`)?.focus();
      });
      return;
    }
    if (action === 'new-task') return openNew();
    if (action === 'calendar-previous') return selectCalendarMonth(addMonths(state.calendarMonth, -1));
    if (action === 'calendar-next') return selectCalendarMonth(addMonths(state.calendarMonth, 1));
    if (action === 'calendar-today') {
      state.selectedDate = todayISO();
      state.calendarMonth = state.selectedDate.slice(0, 7);
      return render();
    }
    if (action === 'open-search') { state.searchOpen = true; state.searchText = ''; return render(); }
    if (action === 'close-search') { state.searchOpen = false; state.searchText = ''; return render(); }
    if (action === 'close-drawer') { state.drawerOpen = false; state.editingId = null; return render(); }
    if (action === 'toggle-completed') { state.prefs.completedOpen = !state.prefs.completedOpen; persist(); return render(); }
    if (action === 'toggle-theme') {
      state.prefs.theme = state.prefs.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = state.prefs.theme === 'dark' ? 'dark' : 'light';
      persist(); return render();
    }
    if (action === 'retry-file-sync') return retryFileSync();
    if (action === 'export-data') return exportData();
    if (action === 'import-data') return document.getElementById('import-file')?.click();
    if (action === 'clear-data') {
      if (confirm('确定要清空所有任务吗？这个操作无法撤销。')) { state.tasks = []; persist(); showToast('任务已清空'); }
      return;
    }

    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    if (action === 'edit-task') { state.editingId = id; state.drawerOpen = true; return render(); }
    if (action === 'search-open-task') { state.searchOpen = false; state.view = 'today'; state.selectedDate = task.date; state.editingId = id; state.drawerOpen = true; return render(); }
    if (action === 'important-task') { task.important = !task.important; task.updatedAt = new Date().toISOString(); persist(); return render(); }
    if (action === 'tomorrow-task') { task.date = addDays(task.date, 1); task.updatedAt = new Date().toISOString(); persist(); showToast('已移到下一天'); return; }
    if (action === 'delete-task') { state.tasks = state.tasks.filter(t => t.id !== id); persist(); showToast('任务已删除'); return; }
    if (action === 'toggle-task') return toggleTask(task);
    if (action === 'undo-complete') {
      task.completed = false; task.completedAt = ''; task.updatedAt = new Date().toISOString(); persist(); state.toast = null; render();
    }
  }

  function selectCalendarMonth(month) {
    const selectedDay = fromISO(state.selectedDate).getDate();
    const target = fromMonthISO(month);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(selectedDay, lastDay));
    state.calendarMonth = month;
    state.selectedDate = toISO(target);
    render();
  }

  function openNew() { state.editingId = null; state.drawerOpen = true; render(); }

  function toggleTask(task) {
    const completing = !task.completed;
    task.completed = completing;
    task.completedAt = completing ? new Date().toISOString() : '';
    task.updatedAt = new Date().toISOString();
    if (completing && task.repeat && task.repeat !== 'none') createNextRepeat(task);
    persist();
    state.toast = completing ? { text: '任务已完成', undoId: task.id } : null;
    render();
    if (completing) setTimeout(() => { if (state.toast?.undoId === task.id) { state.toast = null; render(); } }, 4000);
  }

  function createNextRepeat(task) {
    let next = task.date;
    if (task.repeat === 'daily') next = addDays(next, 1);
    if (task.repeat === 'weekly') next = addDays(next, 7);
    if (task.repeat === 'weekdays') {
      do { next = addDays(next, 1); } while ([0,6].includes(fromISO(next).getDay()));
    }
    const exists = state.tasks.some(t => !t.completed && t.date === next && t.title === task.title && t.repeat === task.repeat);
    if (!exists) state.tasks.push(makeTask({ title: task.title, date: next, time: task.time, notes: task.notes, important: task.important, repeat: task.repeat }));
  }

  function showToast(text, undoId = null) {
    state.toast = { text, undoId };
    render();
    setTimeout(() => { if (state.toast?.text === text) { state.toast = null; render(); } }, 3000);
  }

  function exportData() {
    const exportedAt = new Date().toISOString();
    const backup = {
      app: 'daily-todo',
      version: 1,
      exportedAt,
      tasks: state.tasks,
    };
    if (!state.pendingSnapshot) {
      state.prefs.lastBackupAt = exportedAt;
      persist();
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `daily-todo-backup-${todayISO()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('备份已下载');
  }
})();
