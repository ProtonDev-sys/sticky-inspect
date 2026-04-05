(function () {
  const STORAGE_PREFIX = "permaInspectRules:";
  const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
  const PANEL_HOST_ID = "perma-inspect-host";
  const HIGHLIGHT_ID = "perma-inspect-highlight";
  const INITIAL_CLOAK_ID = "perma-inspect-initial-cloak";
  const REAPPLY_DEBOUNCE_MS = 150;
  const INITIAL_APPLY_INTERVAL_MS = 75;
  const INITIAL_APPLY_WINDOW_MS = 1500;

  const pageKey = getPageKey(window.location.href);
  const storageKey = pageKey ? `${STORAGE_PREFIX}${pageKey}` : null;

  let activeRules = [];
  let observer = null;
  let applyScheduled = false;
  let isApplyingRules = false;

  let pickerActive = false;
  let selectedElement = null;
  let highlightedElement = null;
  let panelHost = null;
  let highlightBox = null;
  let panelElement = null;
  let initialCloakElement = null;
  let panelDragState = null;

  if (isSupportedPage()) {
    installInitialCloak();
  }

  const initialLoadPromise = initialize();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return true;
  });

  async function initialize() {
    if (!isSupportedPage()) {
      removeInitialCloak();
      return false;
    }

    await waitForDocumentElement();
    startObserver();

    activeRules = await readRules();

    if (!activeRules.length) {
      removeInitialCloak();
      return true;
    }

    startInitialApplyBurst();
    return true;
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "permaInspect:getStatus":
        await initialLoadPromise;
        return getStatus();
      case "permaInspect:startPicker":
        await initialLoadPromise;
        return startPicker();
      case "permaInspect:apply":
        await initialLoadPromise;
        return applyRulesNow();
      case "permaInspect:clear":
        await initialLoadPromise;
        return clearRules();
      default:
        return {
          ok: false,
          error: "Unknown message type.",
        };
    }
  }

  async function getStatus() {
    activeRules = await readRules();

    return {
      ok: true,
      supported: isSupportedPage(),
      pageKey,
      ruleCount: activeRules.length,
      pickerActive,
    };
  }

  async function startPicker() {
    if (!isSupportedPage()) {
      return {
        ok: false,
        error: "This page cannot be modified by the extension.",
      };
    }

    if (pickerActive) {
      return {
        ok: true,
        message: "Picker is already active on this tab.",
      };
    }

    ensureOverlay();
    pickerActive = true;
    selectedElement = null;
    highlightedElement = null;

    renderPickerPanel();
    addPickerListeners();

    return {
      ok: true,
      message: "Picker started. Hover an element, then click it.",
    };
  }

  async function applyRulesNow() {
    if (!isSupportedPage()) {
      return {
        ok: false,
        error: "This page cannot be modified by the extension.",
      };
    }

    activeRules = await readRules();
    const appliedCount = applyAllRules();

    return {
      ok: true,
      ruleCount: activeRules.length,
      appliedCount,
    };
  }

  async function clearRules() {
    if (!storageKey) {
      return {
        ok: false,
        error: "This page cannot be modified by the extension.",
      };
    }

    await chrome.storage.local.remove(storageKey);
    activeRules = [];
    stopPicker();

    return {
      ok: true,
      ruleCount: 0,
    };
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }

    observer = new MutationObserver(() => {
      if (isApplyingRules) {
        return;
      }

      scheduleRuleApply();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  function startInitialApplyBurst() {
    const burstStartedAt = Date.now();

    const applyPass = () => {
      applyAllRules();
    };

    const stopBurst = () => {
      window.clearInterval(intervalId);
      removeInitialCloak();
    };

    const intervalId = window.setInterval(() => {
      applyPass();

      if (Date.now() - burstStartedAt >= INITIAL_APPLY_WINDOW_MS) {
        stopBurst();
      }
    }, INITIAL_APPLY_INTERVAL_MS);

    applyPass();

    document.addEventListener(
      "DOMContentLoaded",
      () => {
        applyPass();
      },
      { once: true }
    );

    window.addEventListener(
      "load",
      () => {
        applyPass();
        stopBurst();
      },
      { once: true }
    );
  }

  function scheduleRuleApply() {
    if (applyScheduled) {
      return;
    }

    applyScheduled = true;
    window.setTimeout(() => {
      applyScheduled = false;
      applyAllRules();
    }, REAPPLY_DEBOUNCE_MS);
  }

  function applyAllRules() {
    if (!activeRules.length) {
      return 0;
    }

    let appliedCount = 0;
    isApplyingRules = true;

    try {
      for (const rule of activeRules) {
        appliedCount += applyRule(rule);
      }
    } finally {
      isApplyingRules = false;
    }

    return appliedCount;
  }

  function applyRule(rule) {
    if (!rule?.selector || !rule?.action) {
      return 0;
    }

    let elements;

    try {
      elements = document.querySelectorAll(rule.selector);
    } catch (error) {
      return 0;
    }

    let appliedCount = 0;

    for (const element of elements) {
      if (applyRuleToElement(rule, element)) {
        appliedCount += 1;
      }
    }

    return appliedCount;
  }

  function applyRuleToElement(rule, element) {
    switch (rule.action) {
      case "setText":
        if (element.textContent !== rule.value) {
          element.textContent = rule.value;
        }
        return true;
      case "setHTML":
        if (element.innerHTML !== rule.value) {
          element.innerHTML = rule.value;
        }
        return true;
      case "setValue":
        if ("value" in element && element.value !== rule.value) {
          element.value = rule.value;
          element.setAttribute("value", rule.value);
          return true;
        }
        return false;
      case "setAttribute":
        if (!rule.attributeName) {
          return false;
        }
        if (element.getAttribute(rule.attributeName) !== rule.value) {
          element.setAttribute(rule.attributeName, rule.value);
        }
        return true;
      case "remove":
        if (element.isConnected) {
          element.remove();
        }
        return true;
      default:
        return false;
    }
  }

  async function saveRule(rule) {
    activeRules = upsertRule(activeRules, rule);

    await chrome.storage.local.set({
      [storageKey]: activeRules,
    });

    return activeRules.length;
  }

  function upsertRule(existingRules, nextRule) {
    const filteredRules = existingRules.filter((rule) => {
      return getRuleIdentity(rule) !== getRuleIdentity(nextRule);
    });

    filteredRules.push(nextRule);
    return filteredRules;
  }

  function getRuleIdentity(rule) {
    return [rule.selector, rule.action, rule.attributeName || ""].join("::");
  }

  async function readRules() {
    if (!storageKey) {
      return [];
    }

    const result = await chrome.storage.local.get(storageKey);
    return Array.isArray(result[storageKey]) ? result[storageKey] : [];
  }

  function addPickerListeners() {
    document.addEventListener("mousemove", handlePickerMouseMove, true);
    document.addEventListener("mousedown", handlePickerMouseDown, true);
    document.addEventListener("click", handlePickerClick, true);
    document.addEventListener("keydown", handlePickerKeyDown, true);
    window.addEventListener("scroll", syncHighlightToSelectedElement, true);
    window.addEventListener("resize", syncHighlightToSelectedElement, true);
  }

  function removePickerListeners() {
    document.removeEventListener("mousemove", handlePickerMouseMove, true);
    document.removeEventListener("mousedown", handlePickerMouseDown, true);
    document.removeEventListener("click", handlePickerClick, true);
    document.removeEventListener("keydown", handlePickerKeyDown, true);
    window.removeEventListener("scroll", syncHighlightToSelectedElement, true);
    window.removeEventListener("resize", syncHighlightToSelectedElement, true);
  }

  function handlePickerMouseMove(event) {
    if (!pickerActive) {
      return;
    }

    const candidate = getPickableElement(event.target);
    if (!candidate) {
      return;
    }

    highlightedElement = candidate;
    drawHighlight(candidate);
  }

  function handlePickerMouseDown(event) {
    if (!pickerActive) {
      return;
    }

    const candidate = getPickableElement(event.target);
    if (!candidate) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function handlePickerClick(event) {
    if (!pickerActive) {
      return;
    }

    const candidate = getPickableElement(event.target);
    if (!candidate) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    selectedElement = candidate;
    highlightedElement = candidate;
    drawHighlight(candidate);
    renderEditorPanel(candidate);
  }

  function handlePickerKeyDown(event) {
    if (!pickerActive) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      stopPicker();
    }
  }

  function syncHighlightToSelectedElement() {
    if (selectedElement?.isConnected) {
      drawHighlight(selectedElement);
      return;
    }

    if (highlightedElement?.isConnected) {
      drawHighlight(highlightedElement);
    }
  }

  function getPickableElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    if (panelHost && panelHost.contains(target)) {
      return null;
    }

    if (target.id === HIGHLIGHT_ID) {
      return null;
    }

    if (target === document.documentElement || target === document.body) {
      return null;
    }

    return target;
  }

  function ensureOverlay() {
    if (panelHost && highlightBox && panelElement) {
      return;
    }

    panelHost = document.createElement("div");
    panelHost.id = PANEL_HOST_ID;

    const shadowRoot = panelHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
      }

      #${HIGHLIGHT_ID} {
        position: fixed;
        z-index: 2147483646;
        border: 2px solid #38bdf8;
        background: rgba(56, 189, 248, 0.14);
        pointer-events: none;
        display: none;
        box-sizing: border-box;
      }

      .panel {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 2147483647;
        width: 340px;
        background: linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(15, 23, 42, 0.92));
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.22);
        border-radius: 16px;
        box-shadow: 0 24px 48px rgba(15, 23, 42, 0.42);
        font: 13px/1.4 "Segoe UI", Tahoma, sans-serif;
        overflow: hidden;
        backdrop-filter: blur(14px);
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 12px 14px 10px;
        background: linear-gradient(180deg, rgba(56, 189, 248, 0.16), rgba(56, 189, 248, 0.04));
        border-bottom: 1px solid rgba(148, 163, 184, 0.14);
        cursor: move;
        user-select: none;
      }

      .panel-body {
        padding: 14px;
      }

      .brand {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .eyebrow {
        color: #7dd3fc;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }

      .title {
        font-size: 16px;
        font-weight: 700;
        margin: 0;
      }

      .drag-chip {
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 999px;
        padding: 4px 8px;
        color: #cbd5e1;
        background: rgba(15, 23, 42, 0.6);
        font-size: 11px;
      }

      .copy,
      .selector {
        margin: 0 0 10px;
        color: #cbd5e1;
      }

      .selector {
        font-family: Consolas, "Courier New", monospace;
        font-size: 12px;
        max-height: 80px;
        overflow: auto;
        background: #111827;
        border-radius: 8px;
        padding: 8px;
      }

      .field {
        display: block;
        margin-bottom: 10px;
      }

      .label {
        display: block;
        font-size: 12px;
        color: #cbd5e1;
        margin-bottom: 4px;
      }

      select,
      input,
      textarea,
      button {
        font: inherit;
      }

      select,
      input,
      textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid #475569;
        background: #111827;
        color: #f8fafc;
      }

      textarea {
        min-height: 96px;
        resize: vertical;
      }

      .buttons {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
      }

      button {
        border: 0;
        border-radius: 8px;
        padding: 9px 12px;
        cursor: pointer;
        font-weight: 700;
      }

      .primary {
        background: #38bdf8;
        color: #082f49;
      }

      .secondary {
        background: #334155;
        color: #f8fafc;
      }

      .danger {
        background: rgba(239, 68, 68, 0.16);
        border: 1px solid rgba(248, 113, 113, 0.35);
        color: #fecaca;
      }

      .hidden {
        display: none;
      }

      .status {
        margin-top: 10px;
        min-height: 18px;
        color: #fbbf24;
      }
    `;

    highlightBox = document.createElement("div");
    highlightBox.id = HIGHLIGHT_ID;

    panelElement = document.createElement("section");
    panelElement.className = "panel";

    shadowRoot.append(style, highlightBox, panelElement);
    document.documentElement.appendChild(panelHost);
  }

  function renderPickerPanel(message) {
    if (!panelElement) {
      return;
    }

    panelElement.innerHTML = `
      <div class="panel-header" data-drag-handle="true">
        <div class="brand">
          <span class="eyebrow">Sticky Inspect</span>
          <h1 class="title">Pick an element</h1>
        </div>
        <span class="drag-chip">Drag</span>
      </div>
      <div class="panel-body">
        <p class="copy">${message || "Hover an element and click it to create a saved rule."}</p>
        <p class="copy">Press Esc to cancel.</p>
        <div class="buttons">
          <button type="button" class="secondary" data-action="cancel-picker">Cancel</button>
        </div>
        <p class="status"></p>
      </div>
    `;

    bindPanelDragging();
    const cancelButton = panelElement.querySelector('[data-action="cancel-picker"]');
    cancelButton?.addEventListener("click", () => stopPicker());
  }

  function renderEditorPanel(element) {
    if (!panelElement) {
      return;
    }

    const selector = buildSelector(element);
    const currentText = element.textContent ?? "";
    const currentHTML = element.innerHTML ?? "";
    const currentValue = "value" in element ? element.value ?? "" : currentText;

    panelElement.innerHTML = `
      <div class="panel-header" data-drag-handle="true">
        <div class="brand">
          <span class="eyebrow">Sticky Inspect</span>
          <h1 class="title">Save rule</h1>
        </div>
        <span class="drag-chip">Drag</span>
      </div>
      <div class="panel-body">
        <p class="copy">This selector will be reused across this site after refresh.</p>
        <div class="selector">${escapeHtml(selector)}</div>
        <label class="field">
          <span class="label">Action</span>
          <select data-field="action">
            <option value="setText">Set text</option>
            <option value="setValue">Set value</option>
            <option value="setHTML">Set HTML</option>
            <option value="setAttribute">Set attribute</option>
            <option value="remove">Remove element</option>
          </select>
        </label>
        <label class="field" data-role="attribute-name-wrapper">
          <span class="label">Attribute name</span>
          <input data-field="attributeName" type="text" placeholder="style">
        </label>
        <label class="field" data-role="value-wrapper">
          <span class="label">Saved value</span>
          <textarea data-field="value"></textarea>
        </label>
        <div class="buttons">
          <button type="button" class="primary" data-action="save-rule">Save Rule</button>
          <button type="button" class="secondary" data-action="pick-again">Pick Again</button>
          <button type="button" class="danger" data-action="cancel-picker">Cancel</button>
        </div>
        <p class="status"></p>
      </div>
    `;

    bindPanelDragging();
    const actionSelect = panelElement.querySelector('[data-field="action"]');
    const valueInput = panelElement.querySelector('[data-field="value"]');
    const attributeNameInput = panelElement.querySelector('[data-field="attributeName"]');
    const valueWrapper = panelElement.querySelector('[data-role="value-wrapper"]');
    const attributeWrapper = panelElement.querySelector('[data-role="attribute-name-wrapper"]');
    const statusElement = panelElement.querySelector(".status");

    function syncFields() {
      const action = actionSelect.value;
      attributeWrapper.classList.toggle("hidden", action !== "setAttribute");
      valueWrapper.classList.toggle("hidden", action === "remove");

      if (action === "setText") {
        valueInput.value = currentText;
      } else if (action === "setValue") {
        valueInput.value = currentValue;
      } else if (action === "setHTML") {
        valueInput.value = currentHTML;
      } else if (action === "setAttribute") {
        if (!attributeNameInput.value) {
          attributeNameInput.value = "style";
        }
        valueInput.value = element.getAttribute(attributeNameInput.value) ?? "";
      }
    }

    actionSelect.addEventListener("change", syncFields);
    attributeNameInput.addEventListener("input", () => {
      if (actionSelect.value === "setAttribute") {
        valueInput.value = element.getAttribute(attributeNameInput.value) ?? "";
      }
    });

    panelElement
      .querySelector('[data-action="cancel-picker"]')
      ?.addEventListener("click", () => stopPicker());

    panelElement
      .querySelector('[data-action="pick-again"]')
      ?.addEventListener("click", () => {
        selectedElement = null;
        renderPickerPanel("Hover another element and click it.");
      });

    panelElement
      .querySelector('[data-action="save-rule"]')
      ?.addEventListener("click", async () => {
        const action = actionSelect.value;
        const rule = {
          selector,
          action,
          value: valueInput.value,
          attributeName: attributeNameInput.value.trim(),
          savedAt: Date.now(),
        };

        if (action === "setAttribute" && !rule.attributeName) {
          statusElement.textContent = "Attribute name is required.";
          return;
        }

        if (action === "remove") {
          delete rule.value;
          delete rule.attributeName;
        } else if (action !== "setAttribute") {
          delete rule.attributeName;
        }

        const newCount = await saveRule(rule);
        applyRule(rule);
        statusElement.textContent = `Rule saved. ${newCount} saved rule${newCount === 1 ? "" : "s"} for this site.`;
      });

    syncFields();
  }

  function stopPicker() {
    pickerActive = false;
    selectedElement = null;
    highlightedElement = null;
    panelDragState = null;
    removePickerListeners();

    if (highlightBox) {
      highlightBox.style.display = "none";
    }

    if (panelHost?.isConnected) {
      panelHost.remove();
    }

    panelHost = null;
    highlightBox = null;
    panelElement = null;
  }

  function bindPanelDragging() {
    const handle = panelElement?.querySelector('[data-drag-handle="true"]');
    if (!handle) {
      return;
    }

    handle.addEventListener("mousedown", beginPanelDrag);
  }

  function beginPanelDrag(event) {
    if (event.button !== 0 || !panelElement) {
      return;
    }

    const rect = panelElement.getBoundingClientRect();
    panelDragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    panelElement.style.left = `${rect.left}px`;
    panelElement.style.top = `${rect.top}px`;
    panelElement.style.right = "auto";

    document.addEventListener("mousemove", onPanelDragMove, true);
    document.addEventListener("mouseup", endPanelDrag, true);
    event.preventDefault();
  }

  function onPanelDragMove(event) {
    if (!panelDragState || !panelElement) {
      return;
    }

    const maxLeft = Math.max(8, window.innerWidth - panelElement.offsetWidth - 8);
    const maxTop = Math.max(8, window.innerHeight - panelElement.offsetHeight - 8);
    const nextLeft = clamp(event.clientX - panelDragState.offsetX, 8, maxLeft);
    const nextTop = clamp(event.clientY - panelDragState.offsetY, 8, maxTop);

    panelElement.style.left = `${nextLeft}px`;
    panelElement.style.top = `${nextTop}px`;
  }

  function endPanelDrag() {
    panelDragState = null;
    document.removeEventListener("mousemove", onPanelDragMove, true);
    document.removeEventListener("mouseup", endPanelDrag, true);
  }

  function drawHighlight(element) {
    if (!highlightBox || !element?.isConnected) {
      return;
    }

    const rect = element.getBoundingClientRect();

    highlightBox.style.display = "block";
    highlightBox.style.top = `${rect.top}px`;
    highlightBox.style.left = `${rect.left}px`;
    highlightBox.style.width = `${rect.width}px`;
    highlightBox.style.height = `${rect.height}px`;
  }

  function buildSelector(element) {
    if (element.id) {
      const idSelector = `#${CSS.escape(element.id)}`;
      if (isUniqueSelector(idSelector)) {
        return idSelector;
      }
    }

    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let segment = current.localName;

      if (!segment) {
        break;
      }

      if (current.id) {
        const idSelector = `#${CSS.escape(current.id)}`;
        if (isUniqueSelector(idSelector)) {
          segments.unshift(idSelector);
          return segments.join(" > ");
        }
      }

      const stableAttribute = getStableAttributeSelector(current);
      if (stableAttribute) {
        segment += stableAttribute;
      } else {
        segment += getClassSelector(current);
      }

      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((child) => {
          return child.localName === current.localName;
        });

        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          segment += `:nth-of-type(${index})`;
        }
      }

      segments.unshift(segment);

      const candidate = segments.join(" > ");
      if (isUniqueSelector(candidate)) {
        return candidate;
      }

      current = parent;
    }

    return segments.join(" > ");
  }

  function getStableAttributeSelector(element) {
    const attributeNames = ["data-testid", "data-test", "data-qa", "aria-label", "name"];

    for (const attributeName of attributeNames) {
      const value = element.getAttribute(attributeName);
      if (!value) {
        continue;
      }

      const selector = `[${attributeName}="${CSS.escape(value)}"]`;
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    return "";
  }

  function getClassSelector(element) {
    const classNames = Array.from(element.classList)
      .filter((className) => /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(className))
      .slice(0, 2);

    return classNames.length ? `.${classNames.map((name) => CSS.escape(name)).join(".")}` : "";
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  }

  function isSupportedPage() {
    return Boolean(pageKey) && SUPPORTED_PROTOCOLS.has(window.location.protocol);
  }

  function getPageKey(href) {
    try {
      const url = new URL(href);
      if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
        return null;
      }

      if (url.protocol === "file:") {
        url.hash = "";
        url.search = "";
        return url.toString();
      }

      return getRegistrableDomain(url.hostname);
    } catch (error) {
      return null;
    }
  }

  function getRegistrableDomain(hostname) {
    const normalized = hostname.trim().toLowerCase();

    if (!normalized) {
      return null;
    }

    if (normalized === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
      return normalized;
    }

    const labels = normalized.split(".").filter(Boolean);
    if (labels.length <= 2) {
      return normalized;
    }

    const knownMultipartSuffixes = new Set([
      "co.uk",
      "org.uk",
      "gov.uk",
      "ac.uk",
      "co.jp",
      "com.au",
      "net.au",
      "org.au",
      "co.nz",
      "com.br",
    ]);

    const suffix = labels.slice(-2).join(".");
    if (knownMultipartSuffixes.has(suffix) && labels.length >= 3) {
      return labels.slice(-3).join(".");
    }

    return labels.slice(-2).join(".");
  }

  function installInitialCloak() {
    if (initialCloakElement) {
      return;
    }

    initialCloakElement = document.createElement("style");
    initialCloakElement.id = INITIAL_CLOAK_ID;
    initialCloakElement.textContent = "html{visibility:hidden !important;}";

    appendToDocumentElement(initialCloakElement);
  }

  function removeInitialCloak() {
    if (!initialCloakElement) {
      return;
    }

    if (initialCloakElement.isConnected) {
      initialCloakElement.remove();
    }

    initialCloakElement = null;
  }

  function appendToDocumentElement(node) {
    if (document.documentElement) {
      document.documentElement.appendChild(node);
      return;
    }

    const rootObserver = new MutationObserver(() => {
      if (!document.documentElement) {
        return;
      }

      rootObserver.disconnect();
      document.documentElement.appendChild(node);
    });

    rootObserver.observe(document, {
      childList: true,
      subtree: true,
    });
  }

  function waitForDocumentElement() {
    if (document.documentElement) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const rootObserver = new MutationObserver(() => {
        if (!document.documentElement) {
          return;
        }

        rootObserver.disconnect();
        resolve();
      });

      rootObserver.observe(document, {
        childList: true,
        subtree: true,
      });
    });
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
})();
