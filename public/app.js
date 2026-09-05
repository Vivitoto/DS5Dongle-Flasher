const state = {
  config: null,
  releases: [],
  selectedVariant: 'std',
  selectedTag: null,
  selectedPackage: null,
  prepareSource: null,
  logLines: [],
  serial: {
    port: null,
    reader: null,
    connected: false,
  },
  progress: 0,
  progressLabel: '等待选择 release',
};

const els = {
  appStatus: document.getElementById('appStatus'),
  releaseList: document.getElementById('releaseList'),
  serialState: document.getElementById('serialState'),
  baudRate: document.getElementById('baudRate'),
  connectSerial: document.getElementById('connectSerial'),
  disconnectSerial: document.getElementById('disconnectSerial'),
  reselectSerial: document.getElementById('reselectSerial'),
  flashButton: document.getElementById('flashButton'),
  clearLog: document.getElementById('clearLog'),
  progressBar: document.getElementById('progressBar'),
  progressLabel: document.getElementById('progressLabel'),
  progressValue: document.getElementById('progressValue'),
  packageCard: document.getElementById('packageCard'),
  packageTitle: document.getElementById('packageTitle'),
  packageMeta: document.getElementById('packageMeta'),
  packageFiles: document.getElementById('packageFiles'),
  logWindow: document.getElementById('logWindow'),
  variantStd: document.getElementById('variantStd'),
  variantHs: document.getElementById('variantHs'),
};

function formatDate(value) {
  if (!value) {
    return '未知日期';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function escapeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setStatus(text, tone = 'default') {
  els.appStatus.textContent = text;
  els.appStatus.classList.toggle('muted', tone === 'muted');
}

function setProgress(value, label) {
  const safe = Math.max(0, Math.min(100, Math.round(value || 0)));
  state.progress = safe;
  if (label) {
    state.progressLabel = label;
  }
  els.progressBar.style.width = `${safe}%`;
  els.progressLabel.textContent = state.progressLabel;
  els.progressValue.textContent = `${safe}%`;
}

function appendLog(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  state.logLines.push(line);
  if (state.logLines.length > 300) {
    state.logLines.shift();
  }
  els.logWindow.textContent = state.logLines.join('\n');
  els.logWindow.scrollTop = els.logWindow.scrollHeight;
}

function clearLog() {
  state.logLines = [];
  els.logWindow.textContent = '';
}

function resolveVariantLabel(variant) {
  return variant === 'hs' ? 'HS' : 'STD';
}

function updatePackageSummary() {
  const summary = document.getElementById('packageSummary');
  if (!summary) return;
  const items = [];
  items.push(`<span class="pill subtle">${state.selectedTag ? `已选 ${state.selectedTag}` : '未选择版本'}</span>`);
  items.push(`<span class="pill subtle">${state.serial.connected ? '串口已连接' : '串口未连接'}</span>`);
  items.push(`<span class="pill subtle">${resolveVariantLabel(state.selectedVariant)} 模式</span>`);
  summary.innerHTML = items.join('');
}

function updateVariantButtons() {
  els.variantStd.classList.toggle('active', state.selectedVariant === 'std');
  els.variantHs.classList.toggle('active', state.selectedVariant === 'hs');
}

function renderPackage(pkg) {
  state.selectedPackage = pkg;

  if (!pkg) {
    els.packageCard.classList.add('empty');
    els.packageTitle.textContent = '还没选版本';
    els.packageMeta.textContent = '先点左边的“选中此版本”，再自动拉取、解压并准备文件。';
    els.packageFiles.innerHTML = '';
    return;
  }

  els.packageCard.classList.remove('empty');
  els.packageTitle.textContent = `${pkg.tagName} ${resolveVariantLabel(pkg.variant)}`;
  els.packageMeta.textContent = `${pkg.releaseName || pkg.tagName} • ${pkg.asset?.name || 'Zip asset'} • ${formatDate(pkg.publishedAt)}`;

  const entries = [
    ['Boot2', pkg.selectedFiles?.boot2],
    ['Partition', pkg.selectedFiles?.partition],
    ['Firmware', pkg.selectedFiles?.firmware],
    ['Flash config', pkg.selectedFiles?.flashProgConfig],
    ['Partition TOML', pkg.selectedFiles?.partitionToml],
    ['No-sec TOML', pkg.selectedFiles?.partitionNoSecToml],
    ['Readme', pkg.selectedFiles?.readme],
  ].filter(([, file]) => file);

  els.packageFiles.innerHTML = entries
    .map(([label, file]) => `
      <li>
        <a href="${file.url}" target="_blank" rel="noreferrer">${escapeText(label)}: ${escapeText(file.relativePath)}</a>
        <span>${Math.max(1, Math.round(file.size / 1024))} KB</span>
      </li>
    `)
    .join('');
}

function releaseBodyMarkup(release) {
  const lines = release.body ? release.body.trim().split('\n') : [];
  const safe = lines.length ? lines.map((line) => escapeText(line)).join('\n') : '暂无更新说明。';
  return safe;
}

function setOpenCard(openCard) {
  document.querySelectorAll('.release-card').forEach((card) => {
    if (card !== openCard) {
      card.open = false;
    }
  });
}

function selectRelease(tag) {
  state.selectedTag = tag;
  const release = state.releases.find((item) => item.tagName === tag);
  if (!release) {
    appendLog(`未找到 release：${tag}`);
    return;
  }

  setStatus(`已选中 ${tag}`);
  appendLog(`已选中版本 ${tag}`);
  updatePackageSummary();
  renderReleases();
  prepareRelease(tag, state.selectedVariant);
}

function renderReleases() {
  if (!state.releases.length) {
    els.releaseList.innerHTML = `<div class="subpanel"><p>正在加载 release…</p></div>`;
    return;
  }

  els.releaseList.innerHTML = state.releases.map((release) => {
    const assetName = release.asset?.name || '未找到 zip 资产';
    const badges = [
      release.isLatest ? '<span class="badge latest">最新</span>' : '',
      release.prerelease ? '<span class="badge prerelease">预发布</span>' : '',
      state.selectedTag === release.tagName ? '<span class="badge selected">已选中</span>' : '',
    ].join('');

    return `
      <details class="release-card ${state.selectedTag === release.tagName ? 'selected' : ''}" data-tag="${escapeText(release.tagName)}">
        <summary>
          <div class="release-title">
            <strong>${escapeText(release.tagName)}</strong>
            ${badges}
          </div>
          <span class="release-date">${formatDate(release.publishedAt)}</span>
        </summary>
        <div class="release-body">
          <div class="release-asset">
            <div><strong>资产</strong></div>
            <div>${escapeText(assetName)}</div>
          </div>
          <button class="select-release-button" type="button" data-select-release="${escapeText(release.tagName)}">选中此版本</button>
          <pre class="release-notes">${releaseBodyMarkup(release)}</pre>
        </div>
      </details>
    `;
  }).join('');

  els.releaseList.querySelectorAll('.release-card').forEach((card) => {
    card.addEventListener('toggle', () => {
      if (!card.open) {
        return;
      }

      setOpenCard(card);
    });
  });

  els.releaseList.querySelectorAll('[data-select-release]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      selectRelease(button.dataset.selectRelease);
    });
  });
}

function renderSerialState() {
  els.serialState.textContent = state.serial.connected ? '已连接' : '未连接';
  els.serialState.classList.toggle('muted', !state.serial.connected);
  const packageState = state.selectedPackage
    ? `${state.selectedPackage.tagName} · ${resolveVariantLabel(state.selectedPackage.variant)}`
    : '未选择版本';
  els.packageMeta.setAttribute('data-current-state', `${packageState} | ${state.serial.connected ? '串口已连接' : '串口未连接'}`);
}

async function loadConfig() {
  const response = await fetch('/api/config');
  if (!response.ok) {
    throw new Error(`读取配置失败（${response.status}）`);
  }

  state.config = await response.json();
  setStatus('就绪');
}

async function loadReleases() {
  setStatus('正在拉取 release…', 'muted');
  const response = await fetch('/api/releases');
  if (!response.ok) {
    throw new Error(`读取 release 失败（${response.status}）`);
  }

  const data = await response.json();
  state.releases = data.releases || [];
  renderReleases();
  updatePackageSummary();
  setStatus('就绪');
}

function handlePrepareEvent(eventName, data) {
  if (eventName === 'log') {
    appendLog(data.message);
    return;
  }

  if (eventName === 'progress') {
    setProgress(data.value, data.message);
    if (data.message) {
      setStatus(data.message, 'muted');
    }
    return;
  }

  if (eventName === 'ready') {
    renderPackage(data);
    appendLog(`已准备 ${data.tagName}（${resolveVariantLabel(data.variant)}）`);
    setProgress(100, '准备完成');
    setStatus('准备完成');
  }
}

async function prepareRelease(tag, variant) {
  if (!tag) {
    return;
  }

  closePrepareStream();
  renderPackage(null);
  appendLog(`开始准备 ${tag}（${resolveVariantLabel(variant)}）`);
  setProgress(5, '开始准备');
  setStatus(`正在准备 ${tag}`, 'muted');

  const source = new EventSource(`/api/releases/${encodeURIComponent(tag)}/prepare/stream?variant=${encodeURIComponent(variant)}`);
  state.prepareSource = source;

  source.addEventListener('log', (event) => {
    handlePrepareEvent('log', JSON.parse(event.data));
  });

  source.addEventListener('progress', (event) => {
    handlePrepareEvent('progress', JSON.parse(event.data));
  });

  source.addEventListener('ready', (event) => {
    const payload = JSON.parse(event.data);
    handlePrepareEvent('ready', payload);
    closePrepareStream();
  });

  source.addEventListener('error', (event) => {
    const payload = event.data ? JSON.parse(event.data) : { message: '准备 release 失败' };
    appendLog(payload.message);
    setStatus('准备失败');
    setProgress(0, '失败');
    closePrepareStream();
  });
}

function writeSerialLog(direction, text) {
  const lines = String(text)
    .replace(/\r/g, '')
    .split('\n')
    .filter(Boolean);

  for (const line of lines) {
    appendLog(`${direction} ${line}`);
  }
}

function describePortInfo(port) {
  try {
    const info = port.getInfo?.() || {};
    const parts = [];
    if (info.usbVendorId != null) parts.push(`VID ${info.usbVendorId.toString(16).padStart(4, '0')}`);
    if (info.usbProductId != null) parts.push(`PID ${info.usbProductId.toString(16).padStart(4, '0')}`);
    return parts.length ? parts.join(' / ') : '未知 USB 设备';
  } catch {
    return '未知 USB 设备';
  }
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    appendLog('当前浏览器不支持 Web Serial。');
    setStatus('浏览器不支持串口');
    return;
  }

  if (state.serial.connected) {
    appendLog('串口已经打开。');
    return;
  }

  const baudRate = Number(els.baudRate.value || '115200');
  const grantedPorts = await navigator.serial.getPorts();
  const port = grantedPorts[0] || await navigator.serial.requestPort();
  await port.open({ baudRate });

  state.serial.port = port;
  state.serial.connected = true;
  renderSerialState();
  updatePackageSummary();
  setStatus(`串口已连接 @ ${baudRate}`);
  appendLog(`已打开串口，波特率 ${baudRate}；${describePortInfo(port)}`);
  startSerialReader();
}

async function startSerialReader() {
  if (!state.serial.port?.readable) {
    return;
  }

  const decoder = new TextDecoderStream();
  const reader = state.serial.port.readable.pipeThrough(decoder).getReader();
  state.serial.reader = reader;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        writeSerialLog('<<', value);
      }
    }
  } catch (error) {
    appendLog(`Serial reader stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    state.serial.reader = null;
  }
}

async function disconnectSerial() {
  if (!state.serial.port) {
    return;
  }

  try {
    await state.serial.reader?.cancel();
  } catch {
    // 忽略
  }

  try {
    await state.serial.port.close();
  } catch {
    // 忽略
  }

  state.serial.port = null;
  state.serial.connected = false;
  renderSerialState();
  setStatus('串口已断开');
  appendLog('已关闭串口。');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flashSelected() {
  if (!state.selectedPackage) {
    appendLog('先点开一个 release。');
    return;
  }

  if (!state.serial.connected || !state.serial.port) {
    appendLog('先连接串口。');
    return;
  }

  const pkg = state.selectedPackage;
  appendLog(`开始烧录预览：${pkg.tagName}（${resolveVariantLabel(pkg.variant)}）`);
  setStatus('正在演示烧录流程', 'muted');

  const steps = [
    [10, '检查固件包'],
    [25, '准备启动序列'],
    [45, '选择烧录文件'],
    [65, '写入 boot2 占位步骤'],
    [82, '写入 firmware 占位步骤'],
    [96, '收尾处理'],
    [100, '烧录演示完成'],
  ];

  for (const [value, label] of steps) {
    setProgress(value, label);
    appendLog(label);
    await sleep(220);
  }

  appendLog(`当前演示路径对应的 firmware：${pkg.selectedFiles?.firmware?.relativePath || 'firmware.bin'}`);
  setStatus('烧录演示完成');
}

function setVariant(variant) {
  if (state.selectedVariant === variant) {
    return;
  }

  state.selectedVariant = variant;
  updateVariantButtons();
  appendLog(`已切换到 ${resolveVariantLabel(variant)} 模式`);

  if (state.selectedTag) {
    prepareRelease(state.selectedTag, variant);
  }
}

function bindEvents() {
  els.variantStd.addEventListener('click', () => setVariant('std'));
  els.variantHs.addEventListener('click', () => setVariant('hs'));
  els.connectSerial.addEventListener('click', () => {
    connectSerial().catch((error) => {
      appendLog(error instanceof Error ? error.message : String(error));
      setStatus('串口连接失败');
    });
  });
  els.reselectSerial.addEventListener('click', () => {
    disconnectSerial()
      .then(() => connectSerial())
      .catch((error) => {
        appendLog(error instanceof Error ? error.message : String(error));
        setStatus('串口重选失败');
      });
  });
  els.disconnectSerial.addEventListener('click', () => {
    disconnectSerial().catch((error) => {
      appendLog(error instanceof Error ? error.message : String(error));
    });
  });
  els.flashButton.addEventListener('click', () => {
    flashSelected().catch((error) => {
      appendLog(error instanceof Error ? error.message : String(error));
      setStatus('烧录失败');
    });
  });
  els.clearLog.addEventListener('click', clearLog);
}

async function boot() {
  bindEvents();
  updateVariantButtons();
  renderSerialState();
  renderPackage(null);
  setProgress(0, '等待选择版本');

  try {
    await loadConfig();
    await loadReleases();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus('启动失败');
  }
}

boot();

