const statusElement = document.getElementById("status");
const pageKeyElement = document.getElementById("pageKey");
const pickButton = document.getElementById("pickButton");
const applyButton = document.getElementById("applyButton");
const clearButton = document.getElementById("clearButton");

initializePopup();

async function initializePopup() {
  attachEvents();
  await refreshStatus();
}

function attachEvents() {
  pickButton.addEventListener("click", async () => {
    const response = await runAction("Starting picker...", {
      type: "permaInspect:startPicker",
    });

    if (response?.ok) {
      setStatus(response.message || "Picker started on the current tab.");
      window.close();
    }
  });

  applyButton.addEventListener("click", async () => {
    const response = await runAction("Applying saved rules...", {
      type: "permaInspect:apply",
    });

    if (response?.ok) {
      setStatus(
        `Applied saved rules. ${response.ruleCount} rule${response.ruleCount === 1 ? "" : "s"} stored for this site.`
      );
    }
  });

  clearButton.addEventListener("click", async () => {
    const response = await runAction("Clearing saved rules...", {
      type: "permaInspect:clear",
    });

    if (response?.ok) {
      setStatus("Saved rules cleared for this site.");
    }
  });
}

async function runAction(workingText, message) {
  setWorking(true);
  setStatus(workingText);

  try {
    const response = await sendMessageToActiveTab(message);

    if (!response?.ok) {
      setStatus(response?.error ?? "The action failed.");
      return response;
    }

    await refreshStatus();
    return response;
  } catch (error) {
    setStatus(getReadableError(error));
    return null;
  } finally {
    setWorking(false);
  }
}

async function refreshStatus() {
  try {
    const response = await sendMessageToActiveTab({
      type: "permaInspect:getStatus",
    });

    if (!response?.ok) {
      setStatus(response?.error ?? "The current tab is not available.");
      setPageKey("");
      setButtonsDisabled(true);
      return;
    }

    if (!response.supported) {
      setStatus("This tab cannot be modified by the extension.");
      setPageKey("");
      setButtonsDisabled(true);
      return;
    }

    setButtonsDisabled(false);
    setPageKey(response.pageKey ?? "");

    const pickerText = response.pickerActive ? " Picker is already active." : "";
    setStatus(
      `${response.ruleCount} saved rule${response.ruleCount === 1 ? "" : "s"} for this site.${pickerText}`
    );
  } catch (error) {
    setStatus(getReadableError(error));
    setPageKey("");
    setButtonsDisabled(true);
  }
}

async function sendMessageToActiveTab(message) {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  return chrome.tabs.sendMessage(tab.id, message);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0] ?? null;
}

function setWorking(isWorking) {
  pickButton.disabled = isWorking;
  applyButton.disabled = isWorking;
  clearButton.disabled = isWorking;
}

function setButtonsDisabled(isDisabled) {
  pickButton.disabled = isDisabled;
  applyButton.disabled = isDisabled;
  clearButton.disabled = isDisabled;
}

function setStatus(text) {
  statusElement.textContent = text;
}

function setPageKey(text) {
  pageKeyElement.textContent = text;
}

function getReadableError(error) {
  if (chrome.runtime.lastError?.message) {
    return chrome.runtime.lastError.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
