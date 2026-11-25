
(() => {
  const $ = id => document.getElementById(id);
  const bridge = new UsageBridge();
  const state = {
    range: '7', scope: 'sessions', sort: 'total', direction: 'desc', query: '', offset: 0,
    overview: null, data: null, expanded: new Set(), focusDate: null,
    refresh: null, refreshAt: 0, rowsRequest: 0, chartDays: [],
    searchTimer: null, refreshTimer: null, clockTimer: null, stopped: false,
  };
  const groupNames = { sessions: '会话', projects: '项目', models: '模型' };
  const groupIcons = { sessions: 'chat', projects: 'folder', models: 'model' };
  const metrics = [['input', '输入'], ['output', '输出'], ['cached', '缓存'], ['reasoning', '推理']];
  const number = new Intl.NumberFormat('zh-CN');
  const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const dayKey = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' });
  const longDateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const DAY = 86_400_000;
  const rowsPerPage = 25;
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let localDay = dayKey(timeZone);
  let clock = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let updatedDay;

  function el(tag, cls, value) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value != null) node.textContent = value;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function absoluteTime(stamp, short = false) {
    const date = localDay.format(stamp);
    const [year, month, day] = date.split('-').map(Number);
    const today = localDay.format(Date.now());
    const prefix = short && date === today ? '今日' : `${date.slice(0, 4) === today.slice(0, 4) ? '' : year + '年'}${month}月${day}日`;
    return `${prefix} ${clock.format(stamp)}`;
  }

  function applyTimeZone(zone) {
    if (!zone || zone === timeZone) return;
    try {
      const nextDay = dayKey(zone);
      clock = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      timeZone = zone;
      localDay = nextDay;
    } catch {
      // Keep the platform time zone when the host does not supply a valid zone.
    }
  }

  function countdown(stamp) {
    const seconds = Math.ceil((stamp - Date.now()) / 1000);
    if (seconds <= 0) return '等待更新';
    if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} 天 ${Math.floor(seconds % 86_400 / 3600)} 小时`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
    return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
  }

  function renderQuota() {
    if (!state.overview) return;
    const { quota } = state.overview;
    for (const key of ['fiveHours', 'weekly']) {
      const card = $(key);
      const window = quota.windows[key];
      const status = card.querySelector('.reset');
      const bar = card.querySelector('.track');
      const value = card.querySelector('.percent');
      const time = card.querySelector('.countdown');
      card.dataset.state = window ? 'available' : 'unavailable';
      card.dataset.stale = Boolean(window && quota.stale);
      card.dataset.tone = window?.remaining <= 5 ? 'red' : window?.remaining <= 20 ? 'amber' : 'normal';
      value.replaceChildren(window ? document.createTextNode(percent.format(window.remaining)) : '—');
      if (window) value.append(el('span', 'percent-sign', '%'));
      const suffix = card.querySelector('.remaining');
      suffix.textContent = quota.stale ? '上次记录' : '剩余';
      suffix.hidden = !window;
      bar.style.setProperty('--remaining', `${window?.remaining ?? 0}%`);
      bar.setAttribute('aria-hidden', String(!window));
      if (window) bar.setAttribute('aria-valuenow', String(window.remaining));
      else bar.removeAttribute('aria-valuenow');
      time.hidden = !window?.resetsAt;
      if (window?.resetsAt) {
        status.dateTime = new Date(window.resetsAt).toISOString();
        status.textContent = `${absoluteTime(window.resetsAt, true)} 重置`;
        time.title = quota.stale ? `上次记录 ${absoluteTime(quota.observedAt)}` : '距额度重置';
        status.title = quota.stale ? time.title : absoluteTime(window.resetsAt);
      } else {
        status.removeAttribute('datetime');
        status.textContent = window ? '重置时间未知' : '暂不可用';
        status.title = window ? '' : '当前未取得此额度窗口';
      }
    }
    updateClock();
  }

  function updateClock() {
    if (!state.overview) return;
    const today = localDay.format(Date.now());
    if (updatedDay && updatedDay !== today) {
      updatedDay = today;
      renderQuota();
      renderChart();
    }
    updatedDay = today;
    for (const key of ['fiveHours', 'weekly']) {
      const target = $(key).querySelector('.countdown');
      const reset = state.overview.quota.windows[key]?.resetsAt;
      if (!reset) continue;
      const text = countdown(reset);
      if (target.textContent !== text) target.textContent = text;
    }
  }

  function xLabel(date, yearVisible = false) {
    const [year, month, day] = date.split('-').map(Number);
    return `${yearVisible ? year + '/' : ''}${month}/${day}`;
  }

  function dayCaption(date) {
    const format = date.slice(0, 4) === localDay.format(Date.now()).slice(0, 4) ? dateLabel : longDateLabel;
    return format.format(Date.parse(date));
  }

  function summaryNumber(value) {
    if (value >= 100_000_000) return `${percent.format(value / 100_000_000)} 亿`;
    if (value >= 100_000) return `${percent.format(value / 10_000)} 万`;
    return number.format(value);
  }

  function period() {
    const map = new Map(state.overview?.days ?? []);
    const today = localDay.format(Date.now());
    const end = Date.parse(today + 'T00:00:00Z');
    const earliest = state.overview?.days?.[0]?.[0];
    const start = state.range === 'all' && earliest && earliest <= today
      ? Date.parse(earliest + 'T00:00:00Z') : end - ((Number(state.range) || 7) - 1) * DAY;
    const days = [];
    for (let stamp = start; stamp <= end; stamp += DAY) {
      const date = new Date(stamp).toISOString().slice(0, 10);
      days.push({ date, total: map.get(date) ?? 0, today: date === today });
    }
    return days;
  }

  function stepFor(maximum) {
    if (maximum <= 4) return 1;
    const step = maximum / 4;
    const power = 10 ** Math.floor(Math.log10(step));
    return Math.ceil(power * [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10].find(value => power * value >= step));
  }

  function updateX() {
    const bars = $('bars');
    const days = state.chartDays;
    if (!days.length) return;
    const width = bars.getBoundingClientRect().width;
    const spacing = (width - 4) / days.length;
    bars.style.setProperty('--slot-width', `${spacing}px`);
    const interval = Math.max(1, Math.ceil(63 / spacing));
    for (let i = 0; i < days.length; i++) {
      const show = i === 0 || i === days.length - 1 || (i % interval === 0 && days.length - i - 1 >= interval);
      const label = bars.children[i].lastElementChild;
      const text = show ? xLabel(days[i].date) : '';
      if (text !== label.textContent) label.textContent = text;
    }
  }

  function renderChart(resetScroll = false) {
    const days = period();
    state.chartDays = days;
    const sum = days.reduce((total, day) => total + day.total, 0);
    const peak = days.reduce((maximum, day) => Math.max(maximum, day.total), 0);
    const label = $('chart-total');
    const empty = $('chart-empty');
    label.textContent = state.overview ? summaryNumber(sum) : '—';
    label.title = state.overview ? `${number.format(sum)} Token` : '';
    const first = days[0].date;
    const last = days.at(-1).date;
    const showYear = first.slice(0, 4) !== last.slice(0, 4);
    $('chart-dates').textContent = state.overview ? `${xLabel(first, showYear)} – ${xLabel(last, showYear)}` : '';
    $('chart-dates').title = state.overview ? `${first} – ${last}` : '';
    empty.hidden = Boolean(peak);
    if (state.overview) empty.textContent = '暂无 Token 记录';

    const step = stepFor(peak);
    $('y-axis').replaceChildren(...[4, 3, 2, 1, 0].map(tick => el('span', '', peak ? compact.format(tick * step) : tick === 0 ? '0' : '')));
    const bars = $('bars');
    const scroller = $('plot-scroll');
    const isAtEnd = scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft < 5;
    const oldScroll = scroller.scrollLeft;
    const keyboardInChart = bars.contains(document.activeElement);
    const focusIndex = days.findIndex(day => state.focusDate === day.date);
    const active = focusIndex < 0 || resetScroll ? days.length - 1 : focusIndex;
    state.focusDate = days[active].date;
    bars.style.setProperty('--days', days.length);
    bars.style.setProperty('--min-step', state.range === 'all' && days.length > 30 ? '15px' : '0px');
    bars.dataset.density = days.length > 15 ? 'dense' : 'spaced';
    const contents = document.createDocumentFragment();
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const slot = el('div', 'bar-slot');
      const button = el('button', 'bar-button');
      button.type = 'button';
      button.tabIndex = i === active ? 0 : -1;
      button.dataset.index = i;
      button.dataset.today = day.today;
      button.dataset.zero = day.total === 0;
      button.setAttribute('aria-label', `${dayCaption(day.date)}，${number.format(day.total)} Token`);
      const ink = el('span', 'bar-ink');
      ink.style.setProperty('--height', `${day.total / (step * 4) * 100}%`);
      button.append(ink);
      const tick = el('span', 'x-label');
      tick.setAttribute('aria-hidden', 'true');
      slot.append(button, tick);
      contents.append(slot);
    }
    bars.replaceChildren(contents);
    updateX();
    $('chart-tip').hidden = true;
    if (state.range === 'all' && (resetScroll || isAtEnd)) scroller.scrollLeft = scroller.scrollWidth;
    else scroller.scrollLeft = resetScroll ? 0 : oldScroll;
    if (keyboardInChart) bars.children[active].firstElementChild.focus({ preventScroll: true });
  }

  function showTip(button) {
    const chart = $('chart');
    const tooltip = $('chart-tip');
    const day = state.chartDays[Number(button.dataset.index)];
    if (!day) return;
    const point = button.firstElementChild.getBoundingClientRect();
    const frame = chart.getBoundingClientRect();
    const scroll = $('plot-scroll').getBoundingClientRect();
    if (point.right < scroll.left || point.left > scroll.right) return;
    tooltip.firstElementChild.textContent = dayCaption(day.date);
    tooltip.lastElementChild.textContent = `${number.format(day.total)} Token`;
    tooltip.hidden = false;
    const width = tooltip.offsetWidth;
    const x = Math.min(frame.width - width, Math.max(0, point.left + point.width / 2 - frame.left - width / 2));
    const top = point.top - frame.top - tooltip.offsetHeight - 8;
    tooltip.style.transform = `translate(${x}px, ${top < -26 ? Math.max(2, point.top - frame.top + 8) : top}px)`;
  }

  function focusBar(button) {
    const previous = $('bars').querySelector('[tabindex="0"]');
    if (previous) previous.tabIndex = -1;
    button.tabIndex = 0;
    state.focusDate = state.chartDays[Number(button.dataset.index)].date;
  }

  function changeSorting() {
    $('sort').value = state.sort;
    const direction = $('direction');
    direction.dataset.direction = state.direction;
    const label = state.direction === 'asc' ? '升序，切换为降序' : '降序，切换为升序';
    direction.title = label;
    direction.setAttribute('aria-label', label);
    for (const header of document.querySelectorAll('th[data-sort]')) {
      const old = header.querySelector('.icon');
      old?.remove();
      if (header.dataset.sort === state.sort) {
        header.setAttribute('aria-sort', state.direction === 'asc' ? 'ascending' : 'descending');
        header.querySelector('button').append(icon('order'));
      } else header.removeAttribute('aria-sort');
    }
  }

  function breakdown(row, id) {
    const tr = el('tr', 'expanded');
    tr.id = id;
    tr.hidden = !state.expanded.has(row.id);
    const td = el('td');
    td.colSpan = 6;
    td.append(el('p', 'expanded-title', row.name));
    const details = el('dl', 'metrics');
    const detailMetrics = [['total', '总量'], ...metrics];
    if (row.usage.cacheWrite > 0) detailMetrics.push(['cacheWrite', '缓存写入']);
    for (const [key, label] of detailMetrics) {
      const item = el('div');
      const term = el('dt', '', label);
      if (key === 'input') term.title = '含缓存';
      if (key === 'output') term.title = '含推理';
      item.append(term, el('dd', '', number.format(row.usage[key])));
      details.append(item);
    }
    td.append(details);
    const info = el('div', 'expanded-line');
    if (row.project) info.append(el('span', '', row.project));
    if (row.models?.length) info.append(el('span', '', row.models.join(' · ')));
    const time = el('time', '', absoluteTime(row.updatedAt, true));
    time.dateTime = new Date(row.updatedAt).toISOString();
    time.title = '最近活动';
    info.append(time);
    td.append(info);
    tr.append(td);
    return tr;
  }

  function renderRows(message) {
    const tbody = $('rows');
    const focus = tbody.contains(document.activeElement) ? document.activeElement.dataset.row : null;
    const rows = state.data?.rows ?? [];
    $('row-kind').textContent = groupNames[state.scope];
    if (!rows.length) {
      const tr = el('tr', 'placeholder');
      const cell = el('td', '', message ?? (state.query ? '没有匹配项' : `暂无${groupNames[state.scope]}用量`));
      cell.colSpan = 6;
      tr.append(cell);
      tbody.replaceChildren(tr);
    } else {
      const body = document.createDocumentFragment();
      for (const [i, row] of rows.entries()) {
        const id = `metrics-${i}`;
        const tr = el('tr', 'data-row');
        const first = el('td');
        const button = el('button', 'row-button');
        button.type = 'button';
        button.dataset.row = row.id;
        button.title = row.name;
        button.setAttribute('aria-expanded', String(state.expanded.has(row.id)));
        button.setAttribute('aria-controls', id);
        const symbol = el('span', 'row-kind');
        symbol.append(icon(groupIcons[state.scope]));
        const name = el('span', 'row-title');
        name.append(el('strong', '', row.name));
        const subtitle = row.models ? [row.project, row.models[0], row.models.length > 1 ? `+${row.models.length - 1}` : ''].filter(Boolean).join(' · ')
          : `${number.format(row.sessions)} 个会话`;
        if (subtitle) name.append(el('small', '', subtitle));
        button.append(icon('next'), symbol, name);
        first.append(button);
        tr.append(first);
        for (const key of ['total', ...metrics.map(([key]) => key)]) {
          const text = number.format(row.usage[key]);
          const cell = el('td', key === 'total' ? '' : 'wide', row.usage[key] >= 100_000_000 ? compact.format(row.usage[key]) : text);
          cell.title = text;
          tr.append(cell);
        }
        body.append(tr, breakdown(row, id));
      }
      tbody.replaceChildren(body);
      if (focus) [...tbody.querySelectorAll('.row-button')].find(button => button.dataset.row === focus)?.focus({ preventScroll: true });
    }
    const count = state.data?.totalRows ?? 0;
    $('pages').hidden = count <= rowsPerPage;
    $('page-count').textContent = `${number.format(state.offset + 1)}–${number.format(state.offset + rows.length)} / ${number.format(count)}`;
    $('previous').disabled = state.offset === 0;
    $('next').disabled = state.offset + rowsPerPage >= count;
  }

  async function loadRows(keepVisible = false) {
    const seq = ++state.rowsRequest;
    $('usage-table').setAttribute('aria-busy', 'true');
    if (!keepVisible && !state.data) renderRows('读取中…');
    try {
      const result = await bridge.tool('usage_rows', {
        scope: state.scope, sort: state.sort, direction: state.direction, query: state.query, offset: state.offset,
      });
      if (seq !== state.rowsRequest || state.stopped) return;
      if (state.offset && state.offset >= result.totalRows) {
        state.offset = Math.max(0, Math.ceil(result.totalRows / rowsPerPage) - 1) * rowsPerPage;
        return loadRows();
      }
      state.data = result;
      renderRows();
    } catch {
      if (seq !== state.rowsRequest || state.stopped) return;
      state.data = null;
      renderRows('明细读取失败');
    } finally {
      if (seq === state.rowsRequest) $('usage-table').setAttribute('aria-busy', 'false');
    }
  }

  function setNotice(message) {
    $('notice').hidden = !message;
    $('notice').textContent = message;
  }

  function refresh(force = false) {
    if (state.stopped || state.refresh) return state.refresh;
    state.refreshAt = Date.now();
    const button = $('refresh');
    button.setAttribute('aria-busy', 'true');
    state.refresh = (async () => {
      const request = bridge.tool('usage_overview', { force });
      const details = force ? null : loadRows(true);
      try {
        const overview = await request;
        if (state.stopped) return;
        const first = !state.overview;
        state.overview = overview;
        applyTimeZone(overview.timeZone);
        renderQuota();
        renderChart(first);
        $('updated').textContent = `更新于 ${clock.format(overview.updatedAt)}`;
        $('updated').title = absoluteTime(overview.updatedAt);
        setNotice(overview.partial ? '部分会话读取失败' : '');
        if (details) await details;
        else if (!state.searchTimer) await loadRows(true);
      } catch {
        if (state.stopped) return;
        setNotice('用量读取失败，请重试');
        if (!state.overview) {
          $('chart-empty').textContent = '暂不可用';
          for (const key of ['fiveHours', 'weekly']) $(key).querySelector('.reset').textContent = '暂不可用';
        }
      } finally {
        button.setAttribute('aria-busy', 'false');
        state.refresh = null;
      }
    })();
    return state.refresh;
  }

  function timers() {
    clearInterval(state.refreshTimer);
    clearInterval(state.clockTimer);
    if (state.stopped || document.hidden) return;
    updateClock();
    state.clockTimer = setInterval(updateClock, 1000);
    if ($('auto').checked) {
      if (Date.now() - state.refreshAt >= 60_000) refresh();
      state.refreshTimer = setInterval(() => refresh(), 60_000);
    }
  }

  function segments(id, callback) {
    const group = $(id);
    group.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button || button.getAttribute('aria-pressed') === 'true') return;
      for (const item of group.querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button));
      callback(button.dataset.value);
    });
    group.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...group.querySelectorAll('button')];
      const i = buttons.indexOf(event.target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (i + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    });
  }

  segments('range', value => { state.range = value; renderChart(true); });
  segments('scope', value => {
    state.scope = value;
    state.offset = 0;
    state.data = null;
    state.expanded.clear();
    $('search').placeholder = `搜索${groupNames[value]}`;
    $('search').setAttribute('aria-label', $('search').placeholder);
    loadRows();
  });

  $('bars').addEventListener('pointerover', event => {
    const button = event.target.closest('.bar-button');
    if (button && button !== event.relatedTarget?.closest?.('.bar-button')) showTip(button);
  });
  $('bars').addEventListener('pointerout', event => {
    const button = event.target.closest('.bar-button');
    if (button && button !== event.relatedTarget?.closest?.('.bar-button') && document.activeElement !== button) $('chart-tip').hidden = true;
  });
  $('bars').addEventListener('focusin', event => {
    if (!event.target.matches('.bar-button')) return;
    focusBar(event.target);
    showTip(event.target);
  });
  $('bars').addEventListener('focusout', () => { $('chart-tip').hidden = true; });
  $('bars').addEventListener('click', event => {
    const button = event.target.closest('.bar-button');
    if (!button) return;
    button.focus({ preventScroll: true });
    showTip(button);
  });
  $('bars').addEventListener('keydown', event => {
    const button = event.target.closest('.bar-button');
    if (!button) return;
    if (event.key === 'Escape') { $('chart-tip').hidden = true; return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const i = Number(button.dataset.index);
    const last = state.chartDays.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.max(0, Math.min(last, i + (event.key === 'ArrowRight' ? 1 : -1)));
    $('bars').children[next].firstElementChild.focus();
  });
  $('plot-scroll').addEventListener('scroll', () => {
    $('chart-tip').hidden = true;
    if ($('bars').contains(document.activeElement)) showTip(document.activeElement);
  }, { passive: true });
  new ResizeObserver(updateX).observe($('plot-scroll'));

  let composing = false;
  function search(delay) {
    $('clear').hidden = !$('search').value;
    clearTimeout(state.searchTimer);
    state.query = $('search').value.trim();
    state.offset = 0;
    state.expanded.clear();
    state.rowsRequest++;
    state.searchTimer = setTimeout(() => { state.searchTimer = null; loadRows(true); }, delay);
  }
  $('search').addEventListener('compositionstart', () => { composing = true; });
  $('search').addEventListener('compositionend', () => { composing = false; search(0); });
  $('search').addEventListener('input', event => { if (!composing && !event.isComposing) search(160); });
  function clearSearch() { $('search').value = ''; $('search').focus(); search(0); }
  $('clear').addEventListener('click', clearSearch);
  $('search').addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && $('search').value) { event.preventDefault(); clearSearch(); }
  });
  function sort(field) {
    state.direction = field === state.sort ? (state.direction === 'asc' ? 'desc' : 'asc') : (field === 'name' ? 'asc' : 'desc');
    state.sort = field;
    state.offset = 0;
    changeSorting();
    loadRows(true);
  }
  $('sort').addEventListener('change', event => sort(event.target.value));
  $('direction').addEventListener('click', () => sort(state.sort));
  $('usage-table').querySelector('thead').addEventListener('click', event => {
    const field = event.target.closest('button')?.dataset.sort;
    if (field) sort(field);
  });
  $('rows').addEventListener('click', event => {
    const button = event.target.closest('.row-button');
    if (!button) return;
    const open = button.getAttribute('aria-expanded') === 'true';
    if (open) state.expanded.delete(button.dataset.row);
    else state.expanded.add(button.dataset.row);
    button.setAttribute('aria-expanded', String(!open));
    $(button.getAttribute('aria-controls')).hidden = open;
  });
  $('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - rowsPerPage); state.expanded.clear(); loadRows(true); });
  $('next').addEventListener('click', () => { state.offset += rowsPerPage; state.expanded.clear(); loadRows(true); });
  $('auto').addEventListener('change', timers);
  $('refresh').addEventListener('click', () => refresh(true));
  document.addEventListener('visibilitychange', timers);
  bridge.addEventListener('context', event => {
    if (['dark', 'light'].includes(event.detail.theme)) document.documentElement.dataset.theme = event.detail.theme;
  });
  bridge.addEventListener('teardown', () => { state.stopped = true; timers(); clearTimeout(state.searchTimer); });

  changeSorting();
  renderChart();
  refresh();
  timers();
})();
