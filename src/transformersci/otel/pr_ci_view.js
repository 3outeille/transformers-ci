/* Latest CPU and run-slow results in one panel, with the run table's grouping controls. */
(() => {
  'use strict';
  const pr = new URLSearchParams(location.search).get('pr');
  const runs = document.getElementById('runs');
  const failures = document.getElementById('failures');
  const jobs = document.getElementById('jobs');
  const jobsEmpty = document.getElementById('jobs-empty');
  const onlySpecific = document.getElementById('specific');
  const search = document.getElementById('search');
  const progress = document.getElementById('progress');
  const groupButtons = [...document.querySelectorAll('[data-group]')];
  let snapshot = null, loading = false;
  let group = 'none';
  try {
    const body = parent.document.body;
    if (/light/.test(body.className) || parent.grafanaBootData?.user?.lightTheme) document.body.classList.add('light');
  } catch (_) {}
  try {
    const saved = localStorage.getItem('tci-pr-specific-v2');
    onlySpecific.checked = saved === null ? true : saved === 'true';
  } catch (_) { onlySpecific.checked = true; }
  const node = (tag, cls, value) => {
    const item = document.createElement(tag);
    if (cls) item.className = cls;
    if (value != null) item.textContent = String(value);
    return item;
  };
  const link = (href, label) => {
    const item = node('a', '', label);
    item.href = href;
    item.target = /^https?:/.test(href) ? '_blank' : '_top';
    item.rel = 'noopener';
    return item;
  };
  const runLink = run => run.url || `https://github.com/huggingface/transformers/actions/runs/${String(run.run_id).split(':')[0]}`;
  const live = status => ['in_progress', 'queued', 'waiting', 'requested', 'pending'].includes(status);
  const statusClass = status => ['failure', 'timed_out', 'startup_failure'].includes(status) ? 'failure' : status === 'success' ? 'success' : live(status) ? 'running' : ['skipped', 'cancelled'].includes(status) ? status : 'unknown';
  const laneName = (lane, hardware) => lane.id === 'cpu' ? 'CPU' : lane.id === 'amd' ? (hardware === 'amd-2gpu' ? 'AMD xGPU' : 'AMD GPU') : (hardware === 'multi-gpu' ? 'Nvidia xGPU' : 'Nvidia GPU');
  function renderRuns() {
    runs.replaceChildren();
    for (const lane of snapshot.lanes) {
      const card = node('div', 'run');
      card.append(node('strong', '', lane.label));
      if (lane.run) {
        card.append(link(runLink(lane.run), `Run ${lane.run.run_id}`));
        const status = lane.run.status === 'completed' ? lane.run.conclusion : lane.run.status;
        if (live(status)) card.append(node('span', 'live'));
        card.append(node('small', status === 'success' ? 'good' : statusClass(status) === 'failure' ? 'bad' : 'busy', status.replaceAll('_', ' ')));
      } else card.append(node('small', '', 'No run'));
      runs.append(card);
    }
  }
  function comparisonCard(lane) {
    const comparison = lane.comparison;
    if (!comparison) return null;
    const card = node('div', 'comparison ' + (comparison.state === 'complete' ? '' : comparison.state === 'pending' ? 'pending' : 'bad'));
    const count = comparison.specific.length;
    const summary = comparison.state === 'complete'
      ? count ? `${count} failure${count === 1 ? '' : 's'} attributed to this PR` : 'No failures attributed to this PR'
      : comparison.state === 'pending' ? 'PR-specific analysis pending' : 'PR-specific analysis unavailable';
    card.append(node('strong', '', `${lane.label}: ${summary}`));
    const meta = node('div', 'meta');
    for (const key of ['run', 'pr', 'main']) {
      const sha = comparison.commits[key];
      if (!sha) continue;
      const part = node('span', '', `${key.toUpperCase()} `);
      part.append(link(`https://github.com/huggingface/transformers/commit/${sha}`, sha.slice(0, 8)));
      meta.append(part);
    }
    if (comparison.run_id && lane.run) meta.append(link(runLink(lane.run), 'Workflow and report'));
    if (comparison.report_url) meta.append(link(comparison.report_url, 'Full comparison'));
    card.append(meta);
    return card;
  }
  function testLink(lane, test) {
    if (!/^[0-9a-f]{32}$/.test(test.trace_id) || !lane.run) return null;
    const query = new URLSearchParams({orgId: '1', 'var-trace_id': test.trace_id,
      'var-test_nodeid': test.nodeid, 'var-run_id': lane.run.run_id, 'var-pr': pr,
      'var-gh_run_id': String(lane.run.run_id).split(':')[0]});
    return link(`/d/pytest-test/test?${query}`, test.nodeid);
  }
  function visibleFailures() {
    const listed = [];
    let pending = false;
    for (const lane of snapshot.lanes) {
      const filterable = lane.id !== 'cpu' && lane.comparison?.state === 'complete';
      if (onlySpecific.checked && lane.id !== 'cpu' && !filterable && lane.failures.length) pending = true;
      for (const test of lane.failures) {
        if (onlySpecific.checked && filterable && test.specific !== true) continue;
        const text = `${test.nodeid} ${test.job} ${test.model || ''} ${test.exception_type || ''} ${test.exception_message || ''} ${lane.label}`.toLowerCase();
        if (search.value.trim().toLowerCase().split(/\s+/).filter(Boolean).some(term => !text.includes(term))) continue;
        listed.push({lane, test});
      }
    }
    return {listed, pending};
  }
  function groupKey(item) {
    const {test} = item;
    if (group === 'test') return test.test_name || test.nodeid.split('::').at(-1).replace(/\[.*\]$/, '');
    if (group === 'model') return test.model || '';
    if (group === 'test_model') return `${test.model || ''} · ${test.test_name || test.nodeid.split('::').at(-1)}`;
    return test.job;
  }
  function table(items) {
    const element = node('table', 'test-table');
    const cols = node('colgroup');
    for (const width of ['70px', '', '115px', '92px', '70px']) {
      const col = node('col');
      if (width) col.style.width = width;
      cols.append(col);
    }
    element.append(cols);
    const head = node('thead');
    const headings = node('tr');
    for (const label of ['Status', 'Test', 'Job', 'Lane', 'Duration']) headings.append(node('th', '', label));
    head.append(headings); element.append(head);
    const body = node('tbody');
    for (const {lane, test} of items) {
      const row = node('tr');
      row.append(node('td', 'bad', 'FAIL'));
      const title = node('td', 'nodeid');
      title.append(testLink(lane, test) || node('span', '', test.nodeid));
      if (test.specific === true) title.append(node('span', 'specific', 'PR-specific'));
      else if (test.specific === false) title.append(node('span', 'shared', 'Shared or pre-existing'));
      const error = [test.exception_type, test.exception_message].filter(Boolean).join(': ');
      if (error) title.append(node('div', 'exc', error));
      if (/^[0-9a-f]{32}$/.test(test.trace_id)) {
        const toggle = node('button', 'tb', 'error ▸');
        toggle.type = 'button';
        toggle.dataset.src = `/failure?${new URLSearchParams({trace_id:test.trace_id,test_nodeid:test.nodeid})}`;
        title.append(toggle);
      }
      row.append(title, node('td', '', test.job), node('td', '', laneName(lane, test.hardware)));
      const duration = Number(test.duration_seconds || 0);
      row.append(node('td', 'dur', duration ? `${duration.toFixed(3)}s` : '—'));
      body.append(row);
    }
    element.append(body);
    return element;
  }
  function renderFailures() {
    if (!snapshot) return;
    const opened = new Set([...failures.querySelectorAll('details[open]')].map(item => item.dataset.key));
    failures.replaceChildren();
    for (const lane of snapshot.lanes) {
      const card = comparisonCard(lane);
      if (card) failures.append(card);
      for (const note of lane.notes || []) failures.append(node('div', 'notice', `${lane.label}: ${note}`));
    }
    const {listed, pending} = visibleFailures();
    if (pending) failures.append(node('div', 'notice', 'Comparison pending; unclassified run-slow failures remain visible.'));
    if (!listed.length) {
      failures.append(node('div', 'notice', search.value ? 'No matching failing tests.' : onlySpecific.checked ? 'No PR-specific run-slow failures in these runs.' : 'No failing tests in the latest available runs.'));
      return;
    }
    failures.append(node('div', 'summary', `${listed.length} failing test${listed.length === 1 ? '' : 's'}${group === 'none' ? ' · longest first' : ''}`));
    if (group === 'none') {
      listed.sort((a, b) => Number(b.test.duration_seconds || 0) - Number(a.test.duration_seconds || 0));
      failures.append(table(listed));
      return;
    }
    const groups = new Map();
    for (const item of listed) {
      const key = groupKey(item) || '(unknown)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [key, members] of [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const details = node('details');
      details.dataset.key = key;
      details.open = opened.has(key) || (!opened.size && members.length <= 5);
      const summary = node('summary', '', key);
      summary.append(node('span', 'meta', ` — ${members.length} test${members.length === 1 ? '' : 's'}`));
      details.append(summary, table(members.sort((a, b) => a.test.nodeid.localeCompare(b.test.nodeid))));
      failures.append(details);
    }
  }
  function renderJobs() {
    jobs.replaceChildren();
    const ordered = snapshot.lanes.flatMap(lane => lane.jobs.map(job => ({lane, job})));
    const rank = status => live(status) ? 0 : statusClass(status) === 'failure' ? 1 : status === 'success' ? 2 : 3;
    ordered.sort((a, b) => rank(a.job.status) - rank(b.job.status) || (b.job.fail || 0) - (a.job.fail || 0) || a.job.name.localeCompare(b.job.name));
    for (const {lane, job} of ordered) {
      const tr = node('tr');
      tr.append(node('td', '', laneName(lane, job.hardware)));
      const name = node('td');
      name.append(job.url ? link(job.url, job.name) : node('span', '', job.name));
      tr.append(name);
      const status = node('td', 'status-cell');
      if (live(job.status)) status.append(node('span', 'live'));
      else status.append(node('span', 'state ' + statusClass(job.status), job.status.replaceAll('_', ' ')));
      tr.append(status, node('td', 'dur', job.pass ?? '—'), node('td', 'dur', job.fail ?? '—'));
      jobs.append(tr);
    }
    jobsEmpty.hidden = ordered.length > 0;
    jobsEmpty.textContent = ordered.length ? '' : 'No jobs found in the latest available runs.';
  }
  function render() { renderRuns(); renderFailures(); renderJobs(); }
  async function refresh() {
    if (loading || document.hidden) return;
    if (!/^[1-9][0-9]*$/.test(pr || '')) { runs.textContent = 'Open this view from a PR dashboard.'; progress.hidden = true; return; }
    loading = true; progress.hidden = false;
    try {
      const response = await fetch(`/pr-ci-view/data?pr=${encodeURIComponent(pr)}`, {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(`CI results are temporarily unavailable (HTTP ${response.status}). Retrying shortly…`);
      }
      const data = await response.json();
      snapshot = data; render();
    } catch (error) { runs.textContent = error.message || 'CI results are temporarily unavailable. Retrying shortly…'; }
    finally { loading = false; progress.hidden = true; }
  }
  onlySpecific.addEventListener('change', () => {
    try { localStorage.setItem('tci-pr-specific-v2', String(onlySpecific.checked)); } catch (_) {}
    renderFailures();
  });
  search.addEventListener('input', renderFailures);
  for (const button of groupButtons) button.addEventListener('click', () => {
    group = button.dataset.group;
    for (const candidate of groupButtons) candidate.setAttribute('aria-pressed', String(candidate === button));
    renderFailures();
  });
  groupButtons[0].setAttribute('aria-pressed', 'true');
  failures.addEventListener('click', event => {
    const button = event.target.closest('button.tb');
    if (!button) return;
    const row = button.closest('tr');
    const next = row.nextElementSibling;
    if (next?.classList.contains('tbrow')) { next.remove(); button.textContent = 'error ▸'; return; }
    const extra = node('tr', 'tbrow');
    const cell = node('td'); cell.colSpan = 5;
    const frame = node('iframe'); frame.title = 'Failure details'; frame.src = button.dataset.src;
    frame.addEventListener('load', () => { try { frame.style.height = `${Math.min(600, frame.contentDocument.documentElement.scrollHeight + 4)}px`; } catch (_) {} });
    cell.append(frame); extra.append(cell); row.after(extra); button.textContent = 'error ▾';
  });
  refresh();
  setInterval(refresh, 30000);
})();
