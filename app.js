(() => {
  "use strict";

  const CONFIG = window.RASA_CONFIG || {};
  const STORAGE_KEY = "rasa_connect_device_token_v1";
  const CODE_PATTERN = /^RASA\d{3}$/i;
  const VIEWS = [
    "loadingView",
    "setupView",
    "claimView",
    "dashboardView",
    "scannerView",
    "friendsView",
    "publicCardView",
    "unclaimedView",
    "configErrorView"
  ];

  let db = null;
  let myProfile = null;
  let currentTarget = null;
  let currentCodeFromUrl = null;
  let currentActivationKeyFromUrl = null;
  let qrScanner = null;
  let isScannerRunning = false;
  let toastTimer = null;
  let confirmResolver = null;
  let holdTimer = null;
  let holdStart = null;
  let importedResumeToken = false;
  let resumeLinkCleanupTimer = null;
  let publicCardReturnView = "dashboardView";

  const $ = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindEvents();
    bindCharacterCounters();

    // 若網址帶有瀏覽器接續憑證，先匯入目前瀏覽器，再立即從網址列移除。
    const resumeTokenFromUrl = extractResumeTokenFromUrl(window.location.href);
    if (resumeTokenFromUrl) {
      localStorage.setItem(STORAGE_KEY, resumeTokenFromUrl);
      history.replaceState({}, "", stripResumeFromCurrentUrl());
      importedResumeToken = true;
    }

    currentCodeFromUrl = extractCodeFromUrl(window.location.href);
    currentActivationKeyFromUrl = extractActivationKeyFromUrl(window.location.href);

    if (!isConfigured()) {
      showView("configErrorView");
      return;
    }

    db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    try {
      await refreshMyProfile();
      await routeInitialView();

      if (importedResumeToken) {
        if (myProfile) {
          showToast("已在這個瀏覽器接續你的 RASA 小卡。");
        } else {
          showToast("接續連結無效或已失效，請回到原本瀏覽器重新產生。", true);
        }
      }
    } catch (error) {
      console.error(error);
      showToast(humanizeError(error), true);
      showView("setupView");
    }
  }

  function isConfigured() {
    return (
      typeof CONFIG.SUPABASE_URL === "string" &&
      CONFIG.SUPABASE_URL.startsWith("https://") &&
      !CONFIG.SUPABASE_URL.includes("PASTE_") &&
      typeof CONFIG.SUPABASE_KEY === "string" &&
      CONFIG.SUPABASE_KEY.length > 20 &&
      !CONFIG.SUPABASE_KEY.includes("PASTE_")
    );
  }

  function bindEvents() {
    $("logoButton").addEventListener("click", goHome);
    $("startScanButton").addEventListener("click", openScanner);
    $("closeScannerButton").addEventListener("click", goHome);
    $("manualCodeButton").addEventListener("click", openManualCodeDialog);
    $("openManualCodeButton").addEventListener("click", openManualCodeDialog);
    $("manualCodeForm").addEventListener("submit", handleManualCode);
    $("claimForm").addEventListener("submit", handleClaim);
    $("confirmConnectionButton").addEventListener("click", handleConnection);
    $("backFromCardButton").addEventListener("click", handleBackFromCard);
    $("backFromUnclaimedButton").addEventListener("click", goHome);
    $("showMyQrButton").addEventListener("click", showMyQr);
    $("openFriendsButton").addEventListener("click", openFriendsView);
    $("backFromFriendsButton").addEventListener("click", goHome);
    $("friendsStartScanButton").addEventListener("click", openScanner);
    $("copyMyLinkButton").addEventListener("click", copyMyLink);
    $("prepareBrowserHandoffButton")?.addEventListener("click", prepareBrowserHandoff);
    $("editProfileButton").addEventListener("click", openEditProfile);
    $("editProfileForm").addEventListener("submit", handleEditProfile);
    $("staffForm").addEventListener("submit", handleStaffDeduction);
    $("decreaseAmount").addEventListener("click", () => stepAmount(-1));
    $("increaseAmount").addEventListener("click", () => stepAmount(1));
    $("staffAmount").addEventListener("input", updateDeductionPreview);
    $("closeMilestoneButton").addEventListener("click", () => {
      $("milestoneDialog").close();
      goHome();
    });
    $("confirmCancelButton").addEventListener("click", () => resolveConfirm(false));
    $("confirmOkButton").addEventListener("click", () => resolveConfirm(true));

    // 所有視窗的關閉按鈕統一走同一套邏輯，避免按鈕位於 form 內時被誤判為 submit。
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeDialogById(button.dataset.closeDialog);
      });
    });

    // iPhone Safari 以 ESC／系統返回手勢取消 dialog 時，也要正確結束流程。
    document.querySelectorAll("dialog").forEach((dialog) => {
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (dialog.id === "confirmDialog") {
          resolveConfirm(false);
          return;
        }
        closeDialogById(dialog.id);
      });
    });

    // 點擊 dialog 外圍的黑色背景即可關閉；確認視窗視同取消。
    document.querySelectorAll("dialog.modal").forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        if (event.target !== dialog) return;
        if (dialog.id === "confirmDialog") {
          resolveConfirm(false);
          return;
        }
        closeDialogById(dialog.id);
      });
    });

    bindTokenLongPress();
  }

  function bindCharacterCounters() {
    document.querySelectorAll("[data-count-for]").forEach((counter) => {
      const input = $(counter.dataset.countFor);
      const update = () => {
        counter.textContent = String(input.value.length);
      };
      input.addEventListener("input", update);
      update();
    });
  }

  function bindTokenLongPress() {
    const card = $("tokenCard");

    const start = (event) => {
      if (!myProfile) return;
      holdStart = { x: event.clientX, y: event.clientY };
      card.classList.add("is-holding");
      clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => {
        card.classList.remove("is-holding");
        holdTimer = null;
        navigator.vibrate?.(45);
        openStaffDialog();
      }, 2000);
    };

    const cancel = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      holdStart = null;
      card.classList.remove("is-holding");
    };

    card.addEventListener("pointerdown", start);
    card.addEventListener("pointerup", cancel);
    card.addEventListener("pointercancel", cancel);
    card.addEventListener("pointerleave", cancel);
    card.addEventListener("pointermove", (event) => {
      if (!holdStart) return;
      const distance = Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y);
      if (distance > 12) cancel();
    });

    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openStaffDialog();
      }
    });

    card.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function routeInitialView() {
    if (currentCodeFromUrl) {
      if (myProfile?.code === currentCodeFromUrl) {
        renderDashboard();
        showView("dashboardView");
        return;
      }

      const card = await getPublicCard(currentCodeFromUrl);
      if (card?.is_claimed) {
        currentTarget = card;
        publicCardReturnView = "dashboardView";
        renderPublicCard(card);
        showView("publicCardView");
        return;
      }

      if (!myProfile && currentActivationKeyFromUrl) {
        $("claimCodeText").textContent = currentCodeFromUrl;
        showView("claimView");
      } else {
        showView("unclaimedView");
      }
      return;
    }

    if (myProfile) {
      renderDashboard();
      showView("dashboardView");
    } else {
      showView("setupView");
    }
  }

  async function refreshMyProfile() {
    const token = getDeviceToken();
    if (!token) {
      myProfile = null;
      return null;
    }

    const { data, error } = await db.rpc("get_my_profile", {
      p_device_token: token
    });

    if (error) {
      if (String(error.message || "").includes("INVALID_DEVICE_TOKEN")) {
        localStorage.removeItem(STORAGE_KEY);
        myProfile = null;
        return null;
      }
      throw error;
    }

    myProfile = Array.isArray(data) ? data[0] || null : data;
    return myProfile;
  }

  async function handleClaim(event) {
    event.preventDefault();

    if (!currentCodeFromUrl) {
      showToast("找不到有效的卡片代碼。", true);
      return;
    }

    const payload = {
      code: currentCodeFromUrl,
      nickname: $("claimNickname").value.trim(),
      about: $("claimAbout").value.trim(),
      question: $("claimQuestion").value.trim(),
      link: normalizeOptionalUrl($("claimLink").value.trim())
    };

    if (!payload.nickname || !payload.about || !payload.question) {
      showToast("請完成所有必填欄位。", true);
      return;
    }

    setFormBusy($("claimForm"), true);

    try {
      const { data, error } = await db.rpc("claim_card", {
        p_code: payload.code,
        p_activation_key: currentActivationKeyFromUrl,
        p_nickname: payload.nickname,
        p_about_me: payload.about,
        p_question: payload.question,
        p_personal_link: payload.link || null
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.device_token) throw new Error("沒有收到裝置識別碼。");

      localStorage.setItem(STORAGE_KEY, result.device_token);
      history.replaceState({}, "", stripCodeFromCurrentUrl());
      currentCodeFromUrl = null;
      currentActivationKeyFromUrl = null;
      await refreshMyProfile();
      renderDashboard();
      showView("dashboardView");
      showToast("個人小卡建立完成！");
    } catch (error) {
      console.error(error);
      showToast(humanizeError(error), true);
    } finally {
      setFormBusy($("claimForm"), false);
    }
  }

  async function handleEditProfile(event) {
    event.preventDefault();
    if (!myProfile) return;

    const nickname = $("editNickname").value.trim();
    const about = $("editAbout").value.trim();
    const question = $("editQuestion").value.trim();
    const link = normalizeOptionalUrl($("editLink").value.trim());

    if (!nickname || !about || !question) {
      showToast("請完成所有必填欄位。", true);
      return;
    }

    setFormBusy($("editProfileForm"), true);

    try {
      const { error } = await db.rpc("update_my_card", {
        p_device_token: getDeviceToken(),
        p_nickname: nickname,
        p_about_me: about,
        p_question: question,
        p_personal_link: link || null
      });

      if (error) throw error;
      await refreshMyProfile();
      renderDashboard();
      $("editProfileDialog").close();
      showToast("小卡已更新。");
    } catch (error) {
      console.error(error);
      showToast(humanizeError(error), true);
    } finally {
      setFormBusy($("editProfileForm"), false);
    }
  }

  async function openScanner() {
    if (!myProfile) {
      showToast("請先啟用自己的個人小卡。", true);
      return;
    }

    showView("scannerView");
    $("scannerStatus").textContent = "正在開啟相機⋯";

    try {
      qrScanner = qrScanner || new Html5Qrcode("qrReader");
      const config = {
        fps: 10,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.68);
          return { width: size, height: size };
        },
        aspectRatio: 1
      };

      await qrScanner.start(
        { facingMode: "environment" },
        config,
        handleScanSuccess,
        () => {}
      );
      isScannerRunning = true;
      $("scannerStatus").textContent = "將 QR 放入框線中央。";
    } catch (error) {
      console.error(error);
      $("scannerStatus").textContent = "無法啟動相機，請確認權限或改用手動輸入。";
      showToast("相機啟動失敗，請檢查瀏覽器權限。", true);
    }
  }

  async function stopScanner() {
    if (!qrScanner || !isScannerRunning) return;
    try {
      await qrScanner.stop();
    } catch (error) {
      console.warn("Scanner stop failed:", error);
    } finally {
      isScannerRunning = false;
      $("qrReader").innerHTML = "";
      qrScanner = null;
    }
  }

  async function handleScanSuccess(decodedText) {
    const code = extractCodeFromScan(decodedText);
    if (!code) {
      showToast("這不是有效的 RASA QR。", true);
      return;
    }

    await stopScanner();
    navigator.vibrate?.(35);
    await openCardByCode(code);
  }

  async function openCardByCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) {
      showToast("卡片代碼格式不正確。", true);
      return;
    }

    if (myProfile?.code === normalized) {
      showToast("這是你自己的 QR。");
      goHome();
      return;
    }

    showView("loadingView");

    try {
      const card = await getPublicCard(normalized);
      if (!card?.is_claimed) {
        showView("unclaimedView");
        return;
      }

      currentTarget = card;
      publicCardReturnView = "dashboardView";
      renderPublicCard(card);
      showView("publicCardView");
    } catch (error) {
      console.error(error);
      showToast(humanizeError(error), true);
      goHome();
    }
  }

  async function getPublicCard(code) {
    const { data, error } = await db.rpc("get_public_card", {
      p_code: code
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] || null : data;
  }

  function renderPublicCard(card, options = {}) {
    const isSavedFriend = options.savedFriend === true;

    $("publicCardKicker").textContent = isSavedFriend
      ? "SAVED CONNECTION"
      : "YOU JUST MET";
    $("publicCode").textContent = card.code;
    $("publicNickname").textContent = card.nickname || "尚未命名";
    $("publicAbout").textContent = card.about_me || "—";
    $("publicQuestion").textContent = card.question || "—";

    const link = sanitizeUrl(card.personal_link);
    const linkNode = $("publicLink");
    if (link) {
      linkNode.href = link;
      linkNode.classList.remove("is-hidden");
    } else {
      linkNode.removeAttribute("href");
      linkNode.classList.add("is-hidden");
    }

    const actionArea = $("connectActionArea");
    if (isSavedFriend) {
      actionArea.classList.add("is-hidden");
      return;
    }

    if (myProfile) {
      actionArea.classList.remove("is-hidden");
    } else {
      actionArea.classList.add("is-hidden");
      showToast("請先掃描自己的專屬 QR 啟用小卡，才能累積好友。");
    }
  }

  async function handleConnection() {
    if (!myProfile || !currentTarget) return;

    const confirmed = await askConfirm(
      "確認這次相遇",
      `你與「${currentTarget.nickname}」的好友數與籌碼都會各增加 1。`,
      "確認相遇"
    );
    if (!confirmed) return;

    const button = $("confirmConnectionButton");
    setButtonBusy(button, true, "建立連線中⋯");

    try {
      const { data, error } = await db.rpc("register_connection", {
        p_device_token: getDeviceToken(),
        p_target_code: currentTarget.code
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      await refreshMyProfile();
      renderDashboard();

      if (result?.was_new) {
        showToast(`你與 ${currentTarget.nickname} 成功建立連線！`);
        const milestone = getMilestone(Number(result.friend_count));
        if (milestone) {
          showMilestone(milestone);
        } else {
          goHome();
        }
      } else {
        showToast("你們已經認識過了，好友與籌碼不會重複增加。");
        goHome();
      }
    } catch (error) {
      console.error(error);
      showToast(humanizeError(error), true);
    } finally {
      setButtonBusy(button, false);
    }
  }

  function renderDashboard() {
    if (!myProfile) return;

    const friends = Number(myProfile.friend_count || 0);
    const balance = Number(myProfile.token_balance || 0);
    const goal = Number(CONFIG.FRIEND_GOAL || 10);
    const progress = Math.min(100, Math.max(0, (friends / goal) * 100));

    $("dashboardNickname").textContent = myProfile.nickname;
    $("friendCount").textContent = friends;
    $("friendCountLarge").textContent = friends;
    $("tokenBalance").textContent = balance;
    $("progressFill").style.width = `${progress}%`;
    $("progressMessage").textContent = getProgressMessage(friends);

    document.querySelectorAll("[data-milestone]").forEach((node) => {
      const count = Number(node.dataset.milestone);
      node.classList.toggle("is-reached", friends >= count);
    });
  }

  async function openFriendsView() {
    if (!myProfile) {
      showToast("請先啟用自己的個人小卡。", true);
      return;
    }

    await stopScanner();
    publicCardReturnView = "friendsView";

    $("friendsList").innerHTML = "";
    $("friendsLoading").hidden = false;
    $("friendsEmpty").hidden = true;
    $("friendsCountText").textContent = "正在讀取好友名單⋯";
    showView("friendsView");

    try {
      const { data, error } = await db.rpc("get_my_friends", {
        p_device_token: getDeviceToken()
      });

      if (error) throw error;

      const friends = Array.isArray(data) ? data : [];
      renderFriendsList(friends);
    } catch (error) {
      console.error(error);
      $("friendsLoading").hidden = true;
      $("friendsCountText").textContent = "好友名單載入失敗";
      showToast(humanizeError(error), true);
    }
  }

  function renderFriendsList(friends) {
    const list = $("friendsList");
    const empty = $("friendsEmpty");

    list.innerHTML = "";
    $("friendsLoading").hidden = true;
    $("friendsCountText").textContent = `已收藏 ${friends.length} 位好友`;

    if (!friends.length) {
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    friends.forEach((friend) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "friend-summary-card";
      button.setAttribute(
        "aria-label",
        `查看 ${friend.nickname || friend.code} 的好友小卡`
      );

      const head = document.createElement("div");
      head.className = "friend-summary-head";

      const name = document.createElement("strong");
      name.className = "friend-summary-name";
      name.textContent = friend.nickname || "尚未命名";

      const code = document.createElement("span");
      code.className = "friend-summary-code";
      code.textContent = friend.code;

      head.append(name, code);

      const about = document.createElement("p");
      about.className = "friend-summary-about";
      about.textContent = friend.about_me || "尚未填寫自我介紹";

      const meta = document.createElement("div");
      meta.className = "friend-summary-meta";

      const time = document.createElement("span");
      time.textContent = formatConnectionTime(friend.connected_at);

      const arrow = document.createElement("span");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "→";

      meta.append(time, arrow);
      button.append(head, about, meta);
      button.addEventListener("click", () => openSavedFriend(friend));
      list.appendChild(button);
    });
  }

  function openSavedFriend(friend) {
    currentTarget = friend;
    publicCardReturnView = "friendsView";
    renderPublicCard(friend, { savedFriend: true });
    showView("publicCardView");
  }

  function handleBackFromCard() {
    if (publicCardReturnView === "friendsView") {
      currentTarget = null;
      showView("friendsView");
      return;
    }

    goHome();
  }

  function formatConnectionTime(value) {
    if (!value) return "相遇時間未記錄";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "相遇時間未記錄";

    return `${new Intl.DateTimeFormat("zh-TW", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date)} 相遇`;
  }

  function getProgressMessage(friends) {
    if (friends >= 10) return "最終目標完成，好友數仍可繼續累積。";
    if (friends >= 6) return "距離 E 級社交王，只差最後幾步。";
    if (friends >= 3) return "社交暖機完成，繼續前進。";
    if (friends >= 1) return "第一段連線已建立。";
    return "從第一個相遇開始。";
  }

  function getMilestone(count) {
    return (CONFIG.MILESTONES || []).find((item) => Number(item.count) === count) || null;
  }

  function showMilestone(milestone) {
    $("milestoneKicker").textContent =
      Number(milestone.count) >= Number(CONFIG.FRIEND_GOAL || 10)
        ? "FINAL LEVEL UNLOCKED"
        : "CONNECTION MILESTONE";
    $("milestoneTitle").textContent = milestone.title;
    $("milestoneBody").textContent = milestone.message;
    $("milestoneDialog").showModal();
    navigator.vibrate?.([35, 60, 35]);
  }

  function showMyQr() {
    if (!myProfile) return;

    $("myQrNickname").textContent = myProfile.nickname;
    $("myQrCodeText").textContent = myProfile.code;

    const container = $("myQrCanvas");
    container.innerHTML = "";
    new QRCode(container, {
      text: buildCardUrl(myProfile.code),
      width: 260,
      height: 260,
      colorDark: "#080808",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });

    $("myQrDialog").showModal();
  }

  async function copyMyLink() {
    if (!myProfile) return;
    try {
      await navigator.clipboard.writeText(buildCardUrl(myProfile.code));
      showToast("個人小卡連結已複製。");
    } catch {
      showToast("瀏覽器無法自動複製，請直接顯示 QR。", true);
    }
  }

  async function prepareBrowserHandoff() {
    const deviceToken = getDeviceToken();
    if (!myProfile || !deviceToken) {
      showToast("目前找不到可接續的登入身分。", true);
      return;
    }

    const resumeUrl = buildResumeUrl(deviceToken);
    const resumeLocation = new URL(resumeUrl);

    // 將接續憑證暫時放進目前網址，讓 LINE 的「使用外部瀏覽器開啟」能帶到 Safari／Chrome。
    history.replaceState(
      {},
      "",
      resumeLocation.pathname + resumeLocation.search + resumeLocation.hash
    );

    clearTimeout(resumeLinkCleanupTimer);
    resumeLinkCleanupTimer = window.setTimeout(() => {
      clearResumeHashFromAddressBar();
    }, 5 * 60 * 1000);

    let copied = false;
    try {
      await navigator.clipboard.writeText(resumeUrl);
      copied = true;
    } catch (error) {
      console.warn("Unable to copy browser handoff link:", error);
    }

    showToast(
      copied
        ? "接續連結已準備並複製。現在請從 LINE 選單點選「使用外部瀏覽器開啟」。"
        : "接續連結已準備。現在請從 LINE 選單點選「使用外部瀏覽器開啟」。"
    );
  }

  function openEditProfile() {
    if (!myProfile) return;
    $("editNickname").value = myProfile.nickname || "";
    $("editAbout").value = myProfile.about_me || "";
    $("editQuestion").value = myProfile.question || "";
    $("editLink").value = myProfile.personal_link || "";
    $("editProfileDialog").showModal();
  }

  function openStaffDialog() {
    if (!myProfile) return;
    $("staffCurrentBalance").textContent = myProfile.token_balance;
    $("staffAmount").value = Math.min(1, Number(myProfile.token_balance || 0)) || 1;
    $("staffPin").value = "";
    $("staffNote").value = "";
    updateDeductionPreview();
    $("staffDialog").showModal();
    window.setTimeout(() => $("staffPin").focus(), 80);
  }

  function stepAmount(delta) {
    const input = $("staffAmount");
    const current = Number(input.value || 1);
    const max = Math.max(1, Number(myProfile?.token_balance || 1));
    input.value = String(Math.min(max, Math.max(1, current + delta)));
    updateDeductionPreview();
  }

  function updateDeductionPreview() {
    const amount = Math.max(0, Number($("staffAmount").value || 0));
    const balance = Number(myProfile?.token_balance || 0);
    $("staffRemainingBalance").textContent = String(Math.max(0, balance - amount));
  }

  async function handleStaffDeduction(event) {
    event.preventDefault();
    if (!myProfile) return;

    const amount = Number($("staffAmount").value);
    const pin = $("staffPin").value.trim();
    const note = $("staffNote").value.trim();

    if (!Number.isInteger(amount) || amount <= 0) {
      showToast("請輸入有效的扣除數量。", true);
      return;
    }
    if (amount > Number(myProfile.token_balance)) {
      showToast("籌碼餘額不足。", true);
      return;
    }
    if (!pin) {
      showToast("請輸入工作人員密碼。", true);
      return;
    }

    // 先保存本次資料。即使二次確認視窗開啟，原始表單內容也不會遺失。
    const deduction = {
      amount,
      pin,
      note,
      nickname: myProfile.nickname,
      balanceBefore: Number(myProfile.token_balance)
    };

    const confirmed = await askConfirm(
      "確認扣除籌碼",
      `將從「${deduction.nickname}」扣除 ${deduction.amount} 枚籌碼，扣除後剩餘 ${deduction.balanceBefore - deduction.amount} 枚。`,
      "確認扣除"
    );
    if (!confirmed) return;

    const form = $("staffForm");
    const submitButton = $("staffSubmitButton");
    setFormBusy(form, true);
    if (submitButton) setButtonBusy(submitButton, true, "扣除中⋯");

    try {
      const deviceToken = getDeviceToken();
      if (!deviceToken) throw new Error("INVALID_DEVICE_TOKEN");

      const { data, error } = await db.rpc("spend_tokens", {
        p_device_token: deviceToken,
        p_amount: deduction.amount,
        p_note: deduction.note || null,
        p_staff_pin: deduction.pin
      });

      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result || !Number.isFinite(Number(result.token_balance))) {
        throw new Error("INVALID_SPEND_TOKENS_RESPONSE");
      }

      await refreshMyProfile();
      renderDashboard();
      closeDialogById("staffDialog");
      showToast(`已扣除 ${deduction.amount} 枚籌碼，目前剩餘 ${Number(result.token_balance)} 枚。`);
    } catch (error) {
      console.error("spend_tokens failed:", error);
      showToast(humanizeError(error), true);
    } finally {
      setFormBusy(form, false);
      if (submitButton) setButtonBusy(submitButton, false);
    }
  }

  function closeDialogById(dialogId) {
    const dialog = $(dialogId);
    if (!dialog) return;

    if (dialogId === "manualCodeDialog") {
      $("manualCodeInput").value = "";
      $("manualCodeInput").blur();
    }

    if (dialogId === "staffDialog") {
      $("staffPin").blur();
    }

    if (dialog.open) dialog.close();
  }

  function openManualCodeDialog() {
    const dialog = $("manualCodeDialog");
    $("manualCodeInput").value = "";
    if (!dialog.open) dialog.showModal();
    window.setTimeout(() => $("manualCodeInput").focus(), 80);
  }

  async function handleManualCode(event) {
    event.preventDefault();
    const code = normalizeCode($("manualCodeInput").value);
    if (!code) {
      showToast("請輸入 RASA 加三位數字，例如 RASA023。", true);
      return;
    }

    closeDialogById("manualCodeDialog");
    await stopScanner();
    await openCardByCode(code);
  }

  async function goHome() {
    await stopScanner();
    currentTarget = null;
    publicCardReturnView = "dashboardView";
    history.replaceState({}, "", stripCodeFromCurrentUrl());
    currentCodeFromUrl = null;
    currentActivationKeyFromUrl = null;

    try {
      await refreshMyProfile();
    } catch (error) {
      console.error(error);
    }

    if (myProfile) {
      renderDashboard();
      showView("dashboardView");
    } else {
      showView("setupView");
    }
  }

  function showView(viewId) {
    VIEWS.forEach((id) => {
      $(id).classList.toggle("is-active", id === viewId);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function getDeviceToken() {
    return localStorage.getItem(STORAGE_KEY);
  }

  function normalizeCode(value) {
    const normalized = String(value || "").trim().toUpperCase();
    return CODE_PATTERN.test(normalized) ? normalized : null;
  }

  function extractCodeFromUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return normalizeCode(url.searchParams.get("code"));
    } catch {
      return null;
    }
  }

  function extractActivationKeyFromUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      const key = String(url.searchParams.get("key") || "").trim();
      return /^[a-f0-9]{32}$/i.test(key) ? key : null;
    } catch {
      return null;
    }
  }

  function extractCodeFromScan(value) {
    const direct = normalizeCode(value);
    if (direct) return direct;
    return extractCodeFromUrl(value);
  }

  function buildCardUrl(code) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("code", code);
    return url.toString();
  }

  function stripCodeFromCurrentUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("key");
    return url.pathname + (url.search ? url.search : "") + url.hash;
  }

  function extractResumeTokenFromUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      const params = new URLSearchParams(url.hash.replace(/^#/, ""));
      const token = String(params.get("resume") || "").trim();

      if (token.length < 20 || token.length > 512 || /\s/.test(token)) {
        return null;
      }

      return token;
    } catch {
      return null;
    }
  }

  function buildResumeUrl(deviceToken) {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";

    const params = new URLSearchParams();
    params.set("resume", deviceToken);
    url.hash = params.toString();

    return url.toString();
  }

  function stripResumeFromCurrentUrl() {
    const url = new URL(window.location.href);
    url.hash = "";
    return url.pathname + (url.search ? url.search : "");
  }

  function clearResumeHashFromAddressBar() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    if (!params.has("resume")) return;

    url.hash = "";
    history.replaceState({}, "", url.pathname + (url.search ? url.search : ""));
  }

  function normalizeOptionalUrl(value) {
    if (!value) return "";
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? value
      : `https://${value}`;
    return sanitizeUrl(candidate) || "";
  }

  function sanitizeUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function setFormBusy(form, busy) {
    form.querySelectorAll("button, input, textarea").forEach((node) => {
      node.disabled = busy;
    });
  }

  function setButtonBusy(button, busy, busyText = "處理中⋯") {
    if (!button) return;

    if (busy) {
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
      delete button.dataset.originalText;
    }
  }

  function showToast(message, isError = false) {
    const toast = $("toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("is-error", isError);
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 3600);
  }

  function askConfirm(title, message, okText = "確認") {
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = message;
    $("confirmOkButton").textContent = okText;
    $("confirmDialog").showModal();
    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  function resolveConfirm(result) {
    if ($("confirmDialog").open) $("confirmDialog").close();
    if (confirmResolver) {
      confirmResolver(result);
      confirmResolver = null;
    }
  }

  function humanizeError(error) {
    const message = String(error?.message || error || "");

    const map = [
      ["CARD_NOT_FOUND", "找不到這張 RASA 卡片。"],
      ["CARD_ALREADY_CLAIMED", "這張卡片已經被啟用。"],
      ["INVALID_ACTIVATION_KEY", "這不是完整的啟用 QR，請掃描實體卡片。"],
      ["DEVICE_ALREADY_HAS_CARD", "這個瀏覽器已經綁定另一張卡片。"],
      ["INVALID_DEVICE_TOKEN", "找不到這支手機的身分資料，請洽工作人員。"],
      ["PROFILE_NOT_FOUND", "尚未建立個人小卡。"],
      ["get_my_friends", "好友收藏功能尚未完成 Supabase 設定。"],
      ["TARGET_NOT_FOUND", "找不到對方的小卡。"],
      ["TARGET_NOT_CLAIMED", "對方尚未啟用個人小卡。"],
      ["CANNOT_CONNECT_SELF", "不能將自己加入好友。"],
      ["INVALID_STAFF_PIN", "工作人員密碼不正確。"],
      ["INSUFFICIENT_TOKENS", "可用籌碼不足。"],
      ["INVALID_AMOUNT", "扣除數量不正確。"],
      ["INVALID_SPEND_TOKENS_RESPONSE", "扣款已送出，但資料庫沒有回傳正確餘額，請至 Supabase 檢查。"],
      ["column reference \"token_balance\" is ambiguous", "Supabase 的扣款函式仍有欄位名稱衝突，請先更新 spend_tokens SQL。"],
      ["42702", "Supabase 的扣款函式仍有欄位名稱衝突，請先更新 spend_tokens SQL。"],
      ["INVALID_PROFILE_DATA", "個人小卡內容不完整。"],
      ["INVALID_LINK", "個人連結格式不正確。"],
      ["RATE_LIMITED", "操作速度太快，請稍候再試。"]
    ];

    const found = map.find(([key]) => message.includes(key));
    if (found) return found[1];

    if (message.toLowerCase().includes("failed to fetch")) {
      return "網路連線失敗，請確認行動網路或 Wi-Fi。";
    }

    return "操作未完成，請稍後再試。";
  }
})();