(function () {
  "use strict";

  const { concatBytes, bytesToHex, formatErrorCode } = window.BflbFlashProtocol;
  const { BflbFlasher, BAUD_RATE } = window.BflbFlasher;

  const elements = {
    supportNotice: document.querySelector('#supportNotice'),
    connectButton: document.querySelector('#connectButton'),
    disconnectButton: document.querySelector('#disconnectButton'),
    fileInput: document.querySelector('#binFile'),
    dropZone: document.querySelector('#dropZone'),
    fileName: document.querySelector('#fileName'),
    fileMeta: document.querySelector('#fileMeta'),
    chipSelect: document.querySelector('#chipSelect'),
    autoReset: document.querySelector('#autoReset'),
    runAfterFlash: document.querySelector('#runAfterFlash'),
    flashButton: document.querySelector('#flashButton'),
    loadLatestButton: document.querySelector('#loadLatestButton'),
    cancelButton: document.querySelector('#cancelButton'),
    statusDot: document.querySelector('#statusDot'),
    statusText: document.querySelector('#statusText'),
    stageText: document.querySelector('#stageText'),
    progressBar: document.querySelector('#progressBar'),
    progressValue: document.querySelector('#progressValue'),
    log: document.querySelector('#log'),
    clearLogButton: document.querySelector('#clearLog'),
    releaseList: document.querySelector('#releaseList'),
    packageSummary: document.querySelector('#packageSummary'),
    packageCard: document.querySelector('#packageCard'),
    packageTitle: document.querySelector('#packageTitle'),
    packageMeta: document.querySelector('#packageMeta'),
    packageFiles: document.querySelector('#packageFiles'),
  };

  const state = {
    releases: [],
    selectedVariant: 'std',
    selectedTag: null,
    selectedPackage: null,
    logLines: [],
  };

  let port = null;
  let transport = null;
  let image = null;
  let flashing = false;
  let cancelled = false;

  class SerialTransport {
    constructor(serialPort) {
      this.port = serialPort;
      this.reader = null;
      this.writer = null;
      this.buffer = new Uint8Array();
      this.waiters = new Set();
      this.readError = null;
      this.closed = false;
    }

    async open() {
      await this.port.open({
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 32768,
      });
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.baudRate = BAUD_RATE;
      this.closed = false;
      this.readLoop = this.pump();
    }

    async pump() {
      try {
        while (!this.closed) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            this.buffer = concatBytes(this.buffer, value);
            this.wakeWaiters();
          }
        }
      } catch (error) {
        if (!this.closed) this.readError = error;
      } finally {
        this.wakeWaiters();
      }
    }

    wakeWaiters() {
      for (const resolve of this.waiters) resolve();
      this.waiters.clear();
    }

    async waitForData(timeoutMs) {
      if (this.readError) throw this.readError;
      return new Promise((resolve, reject) => {
        let timer;
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        timer = setTimeout(() => {
          this.waiters.delete(wake);
          reject(new Error('等待设备响应超时'));
        }, timeoutMs);
        this.waiters.add(wake);
      });
    }

    async readExactly(length, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (this.buffer.length < length) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('等待设备响应超时');
        await this.waitForData(remaining);
      }
      const result = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      return result;
    }

    async readUntil(sequence, timeoutMs = 3000) {
      const deadline = performance.now() + timeoutMs;
      while (true) {
        const index = findSequence(this.buffer, sequence);
        if (index >= 0) {
          const result = this.buffer.slice(0, index + sequence.length);
          this.buffer = this.buffer.slice(index + sequence.length);
          return result;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('等待握手响应超时');
        await this.waitForData(remaining);
      }
    }

    async write(bytes) {
      await this.writer.write(bytes);
    }

    async setSignals(signals) {
      await this.port.setSignals(signals);
    }

    async releaseStreams() {
      if (this.reader) {
        const reader = this.reader;
        try {
          await reader.cancel();
          if (this.readLoop) await this.readLoop;
        } catch (_) {
        }
        reader.releaseLock();
        this.reader = null;
      }
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
      if (!this.reader) this.readLoop = null;
    }

    clearInput() {
      this.buffer = new Uint8Array();
    }

    async readAck(timeoutMs = 3000) {
      const ack = await this.readExactly(2, timeoutMs);
      const text = String.fromCharCode(ack[0], ack[1]);
      if (text === 'OK' || text === 'PD') return { status: text };
      if (text === 'FL') {
        const errorBytes = await this.readExactly(2, timeoutMs);
        const code = errorBytes[0] | (errorBytes[1] << 8);
        throw new Error(`设备返回错误 ${formatErrorCode(code)}`);
      }
      throw new Error(`无效设备响应 0x${bytesToHex(ack)}`);
    }

    async readResponse(timeoutMs = 3000) {
      const ack = await this.readAck(timeoutMs);
      if (ack.status !== 'OK') throw new Error(`意外设备响应 ${ack.status}`);
      const lengthBytes = await this.readExactly(2, timeoutMs);
      const length = lengthBytes[0] | (lengthBytes[1] << 8);
      return this.readExactly(length, timeoutMs);
    }

    async close() {
      this.closed = true;
      this.wakeWaiters();
      await this.releaseStreams();
      if (this.port.readable || this.port.writable) await this.port.close();
    }
  }

  function findSequence(haystack, needle) {
    outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
      for (let inner = 0; inner < needle.length; inner += 1) {
        if (haystack[index + inner] !== needle[inner]) continue outer;
      }
      return index;
    }
    return -1;
  }

  function formatSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / 1024 / 1024).toFixed(2)} MiB`;
  }

  function log(message, level = 'info') {
    const row = document.createElement('div');
    row.className = `log-row log-${level}`;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    row.textContent = `${time}  ${message}`;
    elements.log.append(row);
    elements.log.scrollTop = elements.log.scrollHeight;
  }

  function appendLog(message, level = 'info') {
    log(message, level);
  }

  function setStatus(kind, text) {
    elements.statusDot.dataset.status = kind;
    elements.statusText.textContent = text;
  }

  function setProgress(value, stage) {
    const normalized = Math.max(0, Math.min(100, value));
    elements.progressBar.value = normalized;
    elements.progressValue.textContent = `${Math.round(normalized)}%`;
    if (stage) elements.stageText.textContent = stage;
  }

  function updateControls() {
    const connected = Boolean(transport);
    const usable = connected && !transport.closed;
    elements.connectButton.disabled = connected || flashing;
    elements.disconnectButton.disabled = !connected || flashing;
    elements.fileInput.disabled = flashing;
    elements.chipSelect.disabled = flashing;
    elements.flashButton.disabled = !usable || !image || flashing;
    elements.loadLatestButton.disabled = flashing || !connected;
    elements.cancelButton.hidden = !flashing;
  }

  async function chooseFile(file) {
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length < 256) throw new Error('文件太小，不是有效的 whole.bin');
    if (String.fromCharCode(...data.slice(0, 4)) !== 'BFNP') throw new Error('文件 0x0 处没有 Bouffalo Boot Header (BFNP)');
    image = data;
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${formatSize(file.size)} · 写入地址 0x00000000`;
    elements.dropZone.classList.add('has-file');
    setProgress(0, '文件已就绪');
    log(`已载入 ${file.name}，${file.size} 字节`);
    updateControls();
  }

  async function loadPackageFirmware(pkg) {
    const file = pkg?.selectedFiles?.firmware;
    if (!file?.url) throw new Error('release 里没有找到固件文件');
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`读取固件失败（${response.status}）`);
    const data = new Uint8Array(await response.arrayBuffer());
    image = data;
    elements.fileName.textContent = file.relativePath || file.name || 'whole.bin';
    elements.fileMeta.textContent = `${formatSize(data.length)} · 来自 ${pkg.tagName} · 写入地址 0x00000000`;
    elements.dropZone.classList.add('has-file');
    setProgress(0, '固件已从 release 载入');
    log(`已载入 release 固件：${file.relativePath || file.name || 'whole.bin'}`);
    updateControls();
  }

  async function loadReleases() {
    const response = await fetch('/api/releases');
    if (!response.ok) throw new Error(`读取 release 失败（${response.status}）`);
    const data = await response.json();
    state.releases = data.releases || [];
    renderReleases();
    updatePackageSummary();
  }

  async function prepareRelease(tag, variant) {
    const response = await fetch(`/api/releases/${encodeURIComponent(tag)}/prepare?variant=${encodeURIComponent(variant)}`);
    if (!response.ok) throw new Error(`准备 release 失败（${response.status}）`);
    return response.json();
  }

  async function connect() {
    if (!navigator.serial) return;
    try {
      port = await navigator.serial.requestPort();
      transport = new SerialTransport(port);
      await transport.open();
      setStatus('connected', `已连接 · ${transport.baudRate.toLocaleString()} baud`);
      log(`串口已连接，波特率 ${transport.baudRate}`);
    } catch (error) {
      transport = null;
      port = null;
      if (error.name !== 'NotFoundError') {
        setStatus('error', '连接失败');
        log(error.message, 'error');
      }
    }
    updateControls();
  }

  async function disconnect() {
    if (!transport) return;
    const current = transport;
    try {
      await current.close();
      transport = null;
      port = null;
      setStatus('idle', '未连接');
      log('串口已断开');
    } catch (error) {
      log(`关闭串口失败：${error.message}`, 'error');
      setStatus('error', '断开失败，请重试');
    }
    updateControls();
  }

  const STAGE_NAMES = {
    handshake: '进入 BootROM',
    'boot-info': '读取芯片信息',
    'flash-config': '配置 Flash',
    erase: '擦除 Flash',
    verify: '校验写入结果',
    hash: '计算本地 SHA-256',
    done: '烧写完成',
  };

  function handleFlashProgress(value, stage, detail) {
    if (stage === 'write' && detail) {
      setProgress(value, `写入 ${formatSize(detail.written)} / ${formatSize(detail.total)}`);
      return;
    }
    setProgress(value, STAGE_NAMES[stage] || stage);
  }

  async function flash() {
    if (!transport || !image || flashing) return;
    flashing = true;
    cancelled = false;
    updateControls();
    setStatus('working', '正在烧写');
    setProgress(1, '进入 BootROM');
    try {
      const flasher = new BflbFlasher(transport, {
        onLog: (message, level) => {
          log(message, level);
          if (message.startsWith('串口使用')) setStatus('working', '正在烧写 · 2,000,000 baud');
        },
        onProgress: handleFlashProgress,
        isCancelled: () => cancelled,
      });
      const result = await flasher.flashWhole(image, {
        chip: elements.chipSelect.value || undefined,
        autoReset: elements.autoReset.checked,
        runAfterFlash: elements.runAfterFlash.checked,
      });
      const seconds = (result.elapsedMs / 1000).toFixed(1);
      setStatus('success', `${result.chip.toUpperCase()} 烧写完成 · ${seconds} s`);
      log(`烧写和校验完成，用时 ${seconds} 秒`, 'success');
    } catch (error) {
      const wasCancelled = error.name === 'AbortError';
      setStatus(wasCancelled ? 'idle' : 'error', wasCancelled ? '已取消' : '烧写失败');
      elements.stageText.textContent = wasCancelled ? '操作已取消' : error.message;
      log(error.message, wasCancelled ? 'warn' : 'error');
    } finally {
      flashing = false;
      cancelled = false;
      updateControls();
    }
  }

  async function loadLatestAndFlash() {
    try {
      if (!transport) {
        await connect();
      }
      if (!transport) {
        throw new Error('未连接到串口');
      }
      if (!state.releases.length) {
        await loadReleases();
      }
      const latest = state.releases.find((item) => item.isLatest) || state.releases[0];
      if (!latest) throw new Error('没有可用的 release');
      state.selectedTag = latest.tagName;
      updatePackageSummary();
      renderReleases();
      setStatus('working', `正在准备 ${latest.tagName}`);
      const pkg = await prepareRelease(latest.tagName, state.selectedVariant);
      renderPackage(pkg);
      await loadPackageFirmware(pkg);
      await flash();
    } catch (error) {
      appendLog(error instanceof Error ? error.message : String(error));
      setStatus('error', '自动烧录失败');
    }
  }

  function updatePackageSummary() {
    if (!elements.packageSummary) return;
    elements.packageSummary.innerHTML = `
      <span class="pill subtle">${state.selectedTag ? `已选 ${state.selectedTag}` : '未选择版本'}</span>
      <span class="pill subtle">${transport ? '串口已连接' : '串口未连接'}</span>
      <span class="pill subtle">${state.selectedVariant.toUpperCase()} 模式</span>
    `;
  }

  function renderPackage(pkg) {
    if (!elements.packageCard || !elements.packageTitle || !elements.packageMeta || !elements.packageFiles) return;
    state.selectedPackage = pkg;
    if (!pkg) {
      elements.packageCard.classList.add('empty');
      elements.packageTitle.textContent = '还没选包';
      elements.packageMeta.textContent = '点开某个 release 后，会自动拉取、解压并准备好文件。';
      elements.packageFiles.innerHTML = '';
      return;
    }
    elements.packageCard.classList.remove('empty');
    elements.packageTitle.textContent = `${pkg.tagName} ${state.selectedVariant.toUpperCase()}`;
    elements.packageMeta.textContent = `${pkg.releaseName || pkg.tagName} • ${pkg.asset?.name || 'Zip asset'}`;
    const entries = [
      ['Boot2', pkg.selectedFiles?.boot2],
      ['Partition', pkg.selectedFiles?.partition],
      ['Firmware', pkg.selectedFiles?.firmware],
      ['Flash config', pkg.selectedFiles?.flashProgConfig],
      ['Partition TOML', pkg.selectedFiles?.partitionToml],
      ['No-sec TOML', pkg.selectedFiles?.partitionNoSecToml],
      ['Readme', pkg.selectedFiles?.readme],
    ].filter(([, file]) => file);
    elements.packageFiles.innerHTML = entries.map(([label, file]) => `
      <li>
        <a href="${file.url}" target="_blank" rel="noreferrer">${label}: ${file.relativePath}</a>
        <span>${Math.max(1, Math.round(file.size / 1024))} KB</span>
      </li>
    `).join('');
  }

  function renderReleases() {
    if (!elements.releaseList) return;
    if (!state.releases.length) {
      elements.releaseList.innerHTML = '<div class="subpanel"><p>正在加载 release…</p></div>';
      return;
    }
    elements.releaseList.innerHTML = state.releases.map((release) => {
      const assetName = release.asset?.name || '未找到 zip 资产';
      const badges = [
        release.isLatest ? '<span class="badge latest">最新</span>' : '',
        release.prerelease ? '<span class="badge prerelease">预发布</span>' : '',
        state.selectedTag === release.tagName ? '<span class="badge selected">已选中</span>' : '',
      ].join('');
      return `
        <details class="release-card ${state.selectedTag === release.tagName ? 'selected' : ''}" data-tag="${release.tagName}">
          <summary>
            <div class="release-title">
              <strong>${release.tagName}</strong>
              ${badges}
            </div>
            <span class="release-date">${release.publishedAt ? new Date(release.publishedAt).toLocaleDateString('zh-CN') : ''}</span>
          </summary>
          <div class="release-body">
            <div class="release-asset">
              <div><strong>资产</strong></div>
              <div>${assetName}</div>
            </div>
            <button class="select-release-button" type="button" data-select-release="${release.tagName}">选中此版本</button>
            <pre class="release-notes">${release.body ? release.body : '暂无更新说明。'}</pre>
          </div>
        </details>
      `;
    }).join('');

    elements.releaseList.querySelectorAll('.release-card').forEach((card) => {
      card.addEventListener('toggle', () => {
        if (card.open) {
          elements.releaseList.querySelectorAll('.release-card').forEach((other) => {
            if (other !== card) other.open = false;
          });
        }
      });
    });

    elements.releaseList.querySelectorAll('[data-select-release]').forEach((button) => {
      button.addEventListener('click', () => {
        const tag = button.getAttribute('data-select-release');
        state.selectedTag = tag;
        updatePackageSummary();
        renderReleases();
      });
    });
  }

  function bindEvents() {
    elements.connectButton.addEventListener('click', connect);
    elements.disconnectButton.addEventListener('click', disconnect);
    elements.flashButton.addEventListener('click', flash);
    elements.loadLatestButton.addEventListener('click', () => {
      loadLatestAndFlash().catch((error) => {
        appendLog(error instanceof Error ? error.message : String(error));
        setStatus('error', '自动烧录失败');
      });
    });
    elements.clearLogButton.addEventListener('click', () => elements.log.replaceChildren());
    elements.fileInput.addEventListener('change', async () => {
      try {
        await chooseFile(elements.fileInput.files[0]);
      } catch (error) {
        log(error.message, 'error');
      }
    });
    elements.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      elements.dropZone.classList.add('dragging');
    });
    elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('dragging'));
    elements.dropZone.addEventListener('drop', async (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove('dragging');
      try {
        await chooseFile(event.dataTransfer.files[0]);
      } catch (error) {
        log(error.message, 'error');
      }
    });
    navigator.serial?.addEventListener('disconnect', (event) => {
      if (event.target === port) {
        transport = null;
        port = null;
        flashing = false;
        setStatus('error', '设备已断开');
        log('串口设备已断开', 'error');
        updateControls();
      }
    });
  }

  async function boot() {
    bindEvents();
    if (!navigator.serial) {
      elements.supportNotice.hidden = false;
      elements.connectButton.disabled = true;
      setStatus('error', '浏览器不支持 Web Serial');
    }
    try {
      await loadReleases();
      updatePackageSummary();
    } catch (error) {
      log(error.message, 'error');
      setStatus('error', '读取 release 失败');
    }
    updateControls();
  }

  boot();
})();
