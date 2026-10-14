/* The two latest PR CI streams share this view; data is assembled server-side. */
(() => {
  'use strict';
  const pr = new URLSearchParams(location.search).get('pr');
  const runs = document.getElementById('runs');
  const failures = document.getElementById('failures');
  const jobs = document.getElementById('jobs');
  const jobsEmpty = document.getElementById('jobs-empty');
  const onlySpecific = document.getElementById('specific');
  let snapshot = null, loading = false;
  try { onlySpecific.checked = localStorage.getItem('tci-pr-specific') === 'true'; } catch (_) {}
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
  const hardware = value => ({cpu:'CPU','single-gpu':'Nvidia GPU','multi-gpu':'Nvidia xGPU','amd-1gpu':'AMD GPU','amd-2gpu':'AMD xGPU'})[value] || value;
  function renderRuns() {
    runs.replaceChildren();
    for (const lane of snapshot.lanes) {
      const card = node('div', 'run');
      card.append(node('strong', '', lane.label));
      if (lane.run) {
        card.append(link(runLink(lane.run), `Run ${lane.run.run_id}`));
        const status = lane.run.status === 'completed' ? lane.run.conclusion : lane.run.status;
        const cls = status === 'success' ? 'good' : ['failure','timed_out'].includes(status) ? 'bad' : 'busy';
        card.append(node('small', cls, status));
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
    for (const key of ['run','pr','main']) {
      const sha = comparison.commits[key];
      if (!sha) continue;
      const part = node('span', '', `${key.toUpperCase()} `);
      part.append(link(`https://github.com/huggingface/transformers/commit/${sha}`, sha.slice(0, 8)));
      meta.append(part);
    }
    if (comparison.run_id) meta.append(link(runLink(lane.run), 'Workflow and report'));
    card.append(meta);
    return card;
  }
  function testLink(lane, test) {
    if (!/^[0-9a-f]{32}$/.test(test.trace_id)) return null;
    const query = new URLSearchParams({orgId:'1','var-trace_id':test.trace_id,
      'var-test_nodeid':test.nodeid,'var-run_id':lane.run.run_id,'var-pr':pr,
      'var-gh_run_id':String(lane.run.run_id).split(':')[0]});
    return link(`/d/pytest-test/test?${query}`, test.nodeid);
  }
  function renderFailures() {
    failures.replaceChildren();
    let shown = 0, pending = false;
    for (const lane of snapshot.lanes) {
      const card = comparisonCard(lane);
      if (card) failures.append(card);
      for (const note of lane.notes || []) failures.append(node('div', 'notice', `${lane.label}: ${note}`));
      const filterable = lane.id !== 'cpu' && lane.comparison?.state === 'complete';
      if (onlySpecific.checked && lane.id !== 'cpu' && !filterable) pending = true;
      for (const test of lane.failures) {
        if (onlySpecific.checked && filterable && test.specific !== true) continue;
        shown++;
        const row = node('div', 'failure');
        row.append(testLink(lane, test) || node('span', 'title', test.nodeid));
        if (row.firstChild.tagName === 'A') row.firstChild.className = 'title';
        const meta = node('div', 'meta');
        meta.append(node('span', '', lane.label), node('span', '', hardware(test.hardware)), node('span', '', test.job));
        if (lane.id !== 'cpu') {
          const state = test.specific === true ? 'PR-specific' : test.specific === false ? 'Shared or pre-existing' : 'Not yet classified';
          meta.append(node('span', test.specific === true ? 'specific' : test.specific === false ? 'shared' : 'unknown', state));
        }
        row.append(meta); failures.append(row);
      }
    }
    if (pending) failures.prepend(node('div', 'notice', 'Comparison pending; unclassified run-slow failures remain visible.'));
    if (!shown) failures.append(node('div', 'notice', onlySpecific.checked ? 'No PR-specific run-slow failures in these runs.' : 'No failing tests in the latest available runs.'));
  }
  function renderJobs() {
    jobs.replaceChildren();
    let count = 0;
    for (const lane of snapshot.lanes) for (const job of lane.jobs) {
      count++;
      const tr = node('tr');
      tr.append(node('td', '', lane.id === 'cpu' ? 'CPU' : lane.id === 'amd' ? 'AMD' : 'Nvidia'));
      const name = node('td');
      name.append(job.url ? link(job.url, job.name) : node('span', '', job.name));
      tr.append(name, node('td', '', hardware(job.hardware)), node('td', 'status-' + job.status, job.status.replaceAll('_', ' ')),
        node('td', '', job.pass ?? '—'), node('td', '', job.fail ?? '—'));
      jobs.append(tr);
    }
    jobsEmpty.hidden = count > 0;
    jobsEmpty.textContent = count ? '' : 'No jobs found in the latest available runs.';
  }
  function render() { renderRuns(); renderFailures(); renderJobs(); }
  async function refresh() {
    if (loading || document.hidden) return;
    if (!/^[1-9][0-9]*$/.test(pr || '')) { runs.textContent = 'Open this view from a PR dashboard.'; return; }
    loading = true;
    try {
      const response = await fetch(`/pr-ci-view/data?pr=${encodeURIComponent(pr)}`, {credentials:'same-origin',cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || 'Could not load PR CI');
      snapshot = data;
      render();
    } catch (error) { runs.textContent = error.message || 'Could not load PR CI'; }
    finally { loading = false; }
  }
  onlySpecific.addEventListener('change', () => {
    try { localStorage.setItem('tci-pr-specific', String(onlySpecific.checked)); } catch (_) {}
    if (snapshot) renderFailures();
  });
  refresh();
  setInterval(refresh, 30000);
})();
